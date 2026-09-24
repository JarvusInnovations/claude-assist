import type postgres from 'postgres';
import {
  serializeTranscript,
  findInTranscript,
  readAround,
  serializeSince,
  serializeMessageRange,
  parseMessages,
  DELTA_CHAR_BUDGET,
  type SerializeTranscriptOptions,
  type FindOptions,
  type TranscriptMatch,
  type MessageWindow,
  type SerializedDelta,
  type MessageRangeResult,
} from './transcript.js';
import type { TranscriptMessage, TranscriptStorage } from './types.js';

/**
 * The single choke point for reading a session's archived transcript.
 *
 * specs/behaviors/session-transcript-storage.md: "Readers take ranges" —
 * every consumer of transcript content goes through one of the range
 * operations below (full, a message range, head+tail within a byte budget, a
 * window around an anchor uuid, or grep) instead of loading a whole
 * transcript to use a part of it. That is what lets the storage backend
 * change shape inside this one module instead of across every call site.
 *
 * Two backends, selected per session by its `storage` column:
 *
 * - **inline** (`storage IN ('inline', 'catching_up')`): the legacy
 *   `raw_transcript` TEXT column. Unchanged from `transcript-read-layer` — a
 *   `catching_up` row's `raw_transcript` still holds the complete record
 *   (chunks are a backfill in progress; readers stay on the old column until
 *   the flip to `chunked`).
 * - **chunked** (`storage = 'chunked'`): `sessions.transcript_chunks` +
 *   `sessions.transcript_messages`. Every range operation — `readAround`,
 *   `find`, `messageRange`, `since`, `messagesSince`, `rawByteLength` —
 *   resolves to only the chunks (or the scalar column) the requested range
 *   touches, via the message index (`transcript_messages`) and each chunk's
 *   own `[msg_seq_start, msg_seq_end]`, never by concatenating the whole
 *   chunk series. This is the memory-ceiling win deferred from
 *   `transcript-read-layer` (see that plan's Follow-ups) — a ~400 MB chunked
 *   session costs these readers only what the requested range actually
 *   spans, the same as it always has for the inline backend's SQL
 *   `left`/`right` sampling. `readFull`/`serialize`/`readRawMessages` are the
 *   exception: they're inherently whole-transcript operations (a caller
 *   asking for everything), so the chunked backend still concatenates every
 *   chunk for those — same cost profile as an inline full read.
 *
 * A chunked range read rebases the pure functions in `transcript.ts` (which
 * parse from index 0 = seq 0) onto whatever chunks were actually fetched: it
 * fetches only chunks overlapping the requested seq range, computes
 * `chunkBaseSeq` (the absolute seq the fetched slice's first message
 * actually starts at), calls the pure function with seq arguments shifted by
 * `-chunkBaseSeq`, then shifts the result's `seqStart`/`seqEnd` back by
 * `+chunkBaseSeq` before returning — so every caller-visible seq stays an
 * absolute session seq, identical to what the inline backend (which never
 * needs this rebasing, since it always parses from real seq 0) returns for
 * the same query.
 */

/** `msg_seq_start`/`msg_seq_end` are Postgres INTEGER (int4) columns, so any
 * "no upper bound" sentinel used in a comparison against them has to fit
 * int4 — `Number.MAX_SAFE_INTEGER` overflows it. */
const INT4_MAX = 2147483647;

export class TranscriptReader {
  constructor(private sql: postgres.Sql) {}

  /**
   * Public storage-kind lookup for callers that need to branch on it
   * (e.g. a windowing/outline ceiling that only makes sense for the inline
   * backend's whole-value read — a chunked session has no such ceiling to
   * apply). `null` if no such session exists.
   */
  async storageKind(sessionId: string): Promise<TranscriptStorage | null> {
    return this.getStorage(sessionId);
  }

  /** Convenience wrapper over `storageKind` for a simple yes/no check. */
  async isChunked(sessionId: string): Promise<boolean> {
    return (await this.getStorage(sessionId)) === 'chunked';
  }

  /** `null` if no such session; otherwise its storage discriminator. */
  private async getStorage(sessionId: string): Promise<TranscriptStorage | null> {
    const [row] = await this.sql<{ storage: TranscriptStorage }[]>`
      SELECT storage FROM sessions.sessions WHERE id = ${sessionId}::uuid
    `;
    return row?.storage ?? null;
  }

  /** Concatenate every chunk's content, in order. Only for a session already
   * known to be `storage = 'chunked'`. */
  private async readFullChunked(sessionId: string): Promise<string> {
    const rows = await this.sql<{ content: string }[]>`
      SELECT content FROM sessions.transcript_chunks
      WHERE session_id = ${sessionId}::uuid
      ORDER BY seq ASC
    `;
    return rows.map((r) => r.content).join('');
  }

  /**
   * The full raw transcript text. `null` when no session with this id exists
   * (as opposed to `''`, an existing session with an empty archive).
   */
  async readFull(sessionId: string): Promise<string | null> {
    const [row] = await this.sql<{ storage: TranscriptStorage; raw_transcript: string | null }[]>`
      SELECT storage, raw_transcript FROM sessions.sessions WHERE id = ${sessionId}::uuid
    `;
    if (!row) return null;
    if (row.storage === 'chunked') return this.readFullChunked(sessionId);
    return row.raw_transcript ?? '';
  }

  /**
   * Head+tail sample within a byte budget. The inline backend computes it in
   * SQL (`left`/`right`) so an oversized value never lands on the heap in
   * full; the chunked backend fetches only the boundary chunks (by byte
   * range), never the whole chunk series. Returns the sample plus the
   * column's true length so a caller can tell whether it was sampled
   * (`fullLength > budgetBytes`).
   */
  async readHeadTail(
    sessionId: string,
    budgetBytes: number
  ): Promise<{ raw: string; fullLength: number }> {
    const storage = await this.getStorage(sessionId);
    if (storage === null) return { raw: '', fullLength: 0 };

    if (storage !== 'chunked') {
      const half = Math.floor(budgetBytes / 2);
      const [row] = await this.sql<{ raw: string; full_length: number }[]>`
        SELECT
          coalesce(length(raw_transcript), 0) AS full_length,
          CASE
            WHEN raw_transcript IS NULL THEN ''
            WHEN length(raw_transcript) <= ${budgetBytes} THEN raw_transcript
            ELSE left(raw_transcript, ${half}) || E'\n' || right(raw_transcript, ${half})
          END AS raw
        FROM sessions.sessions
        WHERE id = ${sessionId}::uuid
      `;
      return { raw: row?.raw ?? '', fullLength: row?.full_length ?? 0 };
    }

    const [last] = await this.sql<{ byte_end: string | number }[]>`
      SELECT byte_end FROM sessions.transcript_chunks
      WHERE session_id = ${sessionId}::uuid ORDER BY seq DESC LIMIT 1
    `;
    const fullLength = last ? Number(last.byte_end) : 0;
    if (fullLength <= budgetBytes) {
      return { raw: await this.readFullChunked(sessionId), fullLength };
    }

    const half = Math.floor(budgetBytes / 2);
    const headRows = await this.sql<{ content: string }[]>`
      SELECT content FROM sessions.transcript_chunks
      WHERE session_id = ${sessionId}::uuid AND byte_start < ${half}
      ORDER BY seq ASC
    `;
    const tailRows = await this.sql<{ content: string }[]>`
      SELECT content FROM sessions.transcript_chunks
      WHERE session_id = ${sessionId}::uuid AND byte_end > ${fullLength - half}
      ORDER BY seq ASC
    `;
    const headBuf = Buffer.from(headRows.map((r) => r.content).join(''), 'utf8');
    const tailBuf = Buffer.from(tailRows.map((r) => r.content).join(''), 'utf8');
    const head = headBuf.subarray(0, half).toString('utf8');
    const tail = tailBuf.subarray(Math.max(0, tailBuf.length - half)).toString('utf8');
    return { raw: `${head}\n${tail}`, fullLength };
  }

  /**
   * Serialize the full transcript (optionally time-windowed) to the
   * token-efficient `[U]`/`[A]`/`[T]` format. Returns `''` for a missing
   * session or an empty archive — callers that need to distinguish "session
   * not found" from "empty transcript" should use `readFull` directly.
   */
  async serialize(sessionId: string, opts?: SerializeTranscriptOptions): Promise<string> {
    const raw = await this.readFull(sessionId);
    return raw ? serializeTranscript(raw, opts) : '';
  }

/**
   * A bounded message range `[fromSeq, toSeq]` (`toSeq` omitted reads to the
   * end). Chunked sessions fetch only chunks whose `[msg_seq_start,
   * msg_seq_end]` overlaps the request, never the whole chunk series.
   */
  async messageRange(sessionId: string, fromSeq: number, toSeq?: number): Promise<MessageRangeResult> {
    const storage = await this.getStorage(sessionId);
    if (storage === null) return { text: '', seqStart: -1, seqEnd: -1, count: 0 };
    if (storage !== 'chunked') {
      const raw = await this.readFull(sessionId);
      return serializeMessageRange(raw ?? '', fromSeq, toSeq);
    }

    const seqEndBound = toSeq ?? INT4_MAX;
    const chunkRows = await this.sql<{ msg_seq_start: number; content: string }[]>`
      SELECT msg_seq_start, content FROM sessions.transcript_chunks
      WHERE session_id = ${sessionId}::uuid AND msg_seq_end >= ${fromSeq} AND msg_seq_start <= ${seqEndBound}
      ORDER BY seq ASC
    `;
    if (chunkRows.length === 0) return { text: '', seqStart: -1, seqEnd: -1, count: 0 };

    const chunkBaseSeq = chunkRows[0]!.msg_seq_start;
    const bounded = chunkRows.map((r) => r.content).join('');
    const result = serializeMessageRange(
      bounded,
      fromSeq - chunkBaseSeq,
      toSeq !== undefined ? toSeq - chunkBaseSeq : undefined
    );
    if (result.seqStart === -1) return result; // no messages in range
    return { ...result, seqStart: result.seqStart + chunkBaseSeq, seqEnd: result.seqEnd + chunkBaseSeq };
  }

  /**
   * The delta since a classification cursor — an open-ended message range
   * with a char budget and tail-keeping truncation policy (see
   * `serializeSince`). The session is assumed to already exist (callers hold
   * it from a prior select); a missing row degrades to an empty transcript
   * rather than throwing.
   *
   * Chunked sessions never fetch a chunk that ends before `afterSeq` (the
   * hard floor), and — since `serializeSince` keeps only the tail once past
   * the char budget anyway — walk chunks from the newest backward,
   * accumulating only up to roughly the budget's worth of raw bytes (always
   * >= the serialized char count) before stopping. A session that grew by
   * hundreds of MB since `afterSeq` costs this call only the tail it would
   * have kept regardless, not a full concatenation.
   */
  async since(
    sessionId: string,
    afterSeq: number,
    opts?: { maxChars?: number }
  ): Promise<SerializedDelta> {
    const storage = await this.getStorage(sessionId);
    if (storage === null) return { text: '', seqStart: -1, seqEnd: afterSeq, count: 0, truncated: false };
    if (storage !== 'chunked') {
      const raw = await this.readFull(sessionId);
      return serializeSince(raw ?? '', afterSeq, opts);
    }

    const maxChars = opts?.maxChars ?? DELTA_CHAR_BUDGET;
    const qualifying = await this.sql<{ msg_seq_start: number; content: string }[]>`
      SELECT msg_seq_start, content FROM sessions.transcript_chunks
      WHERE session_id = ${sessionId}::uuid AND msg_seq_end >= ${afterSeq + 1}
      ORDER BY seq DESC
    `;
    if (qualifying.length === 0) {
      return { text: '', seqStart: -1, seqEnd: afterSeq, count: 0, truncated: false };
    }

    const picked: typeof qualifying = [];
    let bytes = 0;
    for (const row of qualifying) {
      picked.push(row);
      bytes += Buffer.byteLength(row.content, 'utf8');
      if (bytes >= maxChars) break; // raw bytes are always >= the serialized char count
    }
    const droppedOlderChunks = picked.length < qualifying.length;
    picked.reverse(); // back to ascending seq order

    const chunkBaseSeq = picked[0]!.msg_seq_start;
    const bounded = picked.map((r) => r.content).join('');
    const result = serializeSince(bounded, afterSeq - chunkBaseSeq, opts);
    if (result.seqStart === -1) {
      // No new messages in the fetched slice — restore the caller's absolute afterSeq.
      return { ...result, seqEnd: result.seqEnd + chunkBaseSeq };
    }
    return {
      ...result,
      seqStart: result.seqStart + chunkBaseSeq,
      seqEnd: result.seqEnd + chunkBaseSeq,
      truncated: result.truncated || droppedOlderChunks,
    };
  }

  /**
   * A ± message window around an anchor uuid (the exploration follow-up to
   * `find`). `sessionFound: false` distinguishes a missing session from a
   * session whose transcript doesn't contain the anchor uuid (`window: null`).
   *
   * Chunked sessions resolve the anchor's seq via `transcript_messages` and
   * fetch only the chunks whose message range overlaps `[seq-before,
   * seq+after]` — never the whole chunk series.
   */
  async readAround(
    sessionId: string,
    anchorUuid: string,
    before: number,
    after: number
  ): Promise<{ sessionFound: boolean; window: MessageWindow | null }> {
    const storage = await this.getStorage(sessionId);
    if (storage === null) return { sessionFound: false, window: null };

    if (storage !== 'chunked') {
      const raw = await this.readFull(sessionId);
      if (raw === null) return { sessionFound: false, window: null };
      return { sessionFound: true, window: readAround(raw, anchorUuid, before, after) };
    }

    const [anchor] = await this.sql<{ seq: number }[]>`
      SELECT seq FROM sessions.transcript_messages
      WHERE session_id = ${sessionId}::uuid AND uuid = ${anchorUuid}
    `;
    if (!anchor) return { sessionFound: true, window: null };

    const seqStart = Math.max(0, anchor.seq - Math.max(0, before));
    const seqEnd = anchor.seq + Math.max(0, after);

    const chunkRows = await this.sql<{ content: string }[]>`
      SELECT content FROM sessions.transcript_chunks
      WHERE session_id = ${sessionId}::uuid
        AND msg_seq_end >= ${seqStart} AND msg_seq_start <= ${seqEnd}
      ORDER BY seq ASC
    `;
    const bounded = chunkRows.map((r) => r.content).join('');
    // The fetched chunks are a contiguous slice covering [seqStart, seqEnd],
    // so the pure `readAround` finds the anchor correctly within it — the
    // relative index differs from the session's absolute seq, but the window
    // it builds (anchor/head/tail uuids, truncation) is self-consistent.
    return { sessionFound: true, window: readAround(bounded, anchorUuid, before, after) };
  }

  /**
   * Windowed tool/text matches within one session — the grep path (#48).
   * `sessionFound: false` distinguishes a missing session (404) from a
   * session with zero matches (200, empty list).
   *
   * Chunked sessions resolve `afterUuid`/`beforeUuid` (if given) to a seq
   * range via `transcript_messages` and grep only the chunks that range
   * overlaps; an unbounded search (no afterUuid/beforeUuid) still has to
   * cover the whole transcript, so it fetches every chunk — matching what an
   * unbounded search over `raw_transcript` already costs on the inline
   * backend.
   */
  async find(
    sessionId: string,
    opts: FindOptions
  ): Promise<{ sessionFound: boolean; matches: TranscriptMatch[] }> {
    const storage = await this.getStorage(sessionId);
    if (storage === null) return { sessionFound: false, matches: [] };

    if (storage !== 'chunked') {
      const raw = await this.readFull(sessionId);
      if (raw === null) return { sessionFound: false, matches: [] };
      return { sessionFound: true, matches: findInTranscript(raw, opts) };
    }

    // Sentinel bounds rather than conditional SQL fragments: an absent
    // afterUuid/beforeUuid just means "no lower/upper bound", so the same
    // unconditional query shape covers a bounded or fully unbounded search
    // (which still has to cover the whole transcript, matching what an
    // unbounded search over `raw_transcript` already costs on the inline
    // backend).
    let seqStart = 0;
    let seqEnd = INT4_MAX;
    if (opts.afterUuid) {
      const [row] = await this.sql<{ seq: number }[]>`
        SELECT seq FROM sessions.transcript_messages WHERE session_id = ${sessionId}::uuid AND uuid = ${opts.afterUuid}
      `;
      if (row) seqStart = row.seq + 1;
    }
    if (opts.beforeUuid) {
      const [row] = await this.sql<{ seq: number }[]>`
        SELECT seq FROM sessions.transcript_messages WHERE session_id = ${sessionId}::uuid AND uuid = ${opts.beforeUuid}
      `;
      if (row) seqEnd = row.seq - 1;
    }

    const chunkRows = await this.sql<{ msg_seq_start: number; content: string }[]>`
      SELECT msg_seq_start, content FROM sessions.transcript_chunks
      WHERE session_id = ${sessionId}::uuid AND msg_seq_end >= ${seqStart} AND msg_seq_start <= ${seqEnd}
      ORDER BY seq ASC
    `;
    if (chunkRows.length === 0) return { sessionFound: true, matches: [] };
    const chunkBaseSeq = chunkRows[0]!.msg_seq_start;
    const bounded = chunkRows.map((r) => r.content).join('');
    // findInTranscript's `.index` is an ordinal into whatever text it's given
    // — rebase it back to an absolute session seq so a chunked session's
    // matches carry the same `index` an inline session's would.
    const matches = findInTranscript(bounded, opts).map((m) => ({ ...m, index: m.index + chunkBaseSeq }));
    return { sessionFound: true, matches };
  }

  /**
   * Every raw JSONL line parsed to a plain object, malformed lines dropped —
   * backs the session-detail `with_raw_messages` view. Unlike `parseMessages`
   * this keeps every line type (e.g. `custom-title`), matching that view's
   * historical behavior. `[]` for a missing session or empty archive.
   */
  async readRawMessages(sessionId: string): Promise<unknown[]> {
    const raw = await this.readFull(sessionId);
    if (!raw) return [];
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /**
   * Session ids whose archive is present and non-empty — for one-time
   * scripts that walk the whole corpus (e.g. `scripts/reparse-*.ts`). Callers
   * fetch each session's content one at a time via `readFull`, never all at
   * once: the archive totals multiple GB across the corpus.
   */
  async listSessionIdsWithContent(): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM sessions.sessions
      WHERE (raw_transcript IS NOT NULL AND raw_transcript != '')
         OR storage = 'chunked'
    `;
    return rows.map((r) => r.id);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Added for windowed outlines (specs/behaviors/session-outlines.md).
  // Grouped at the end per the read layer's convention: existing methods
  // above are unchanged, these are additions.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Raw transcript byte length without fetching content — the scalar half of
   * what `readHeadTail` already computes in SQL. Lets a caller decide whether
   * a session is large enough to window without paying to fetch bytes it only
   * needed to count. For a chunked session this is `ingested_bytes`, not
   * `length(raw_transcript)` — that column is null once a session is
   * chunked, and returning 0 there would silently defeat any ceiling a
   * caller applies against this value (see `outline.ts`'s `isWindowed`).
   */
  async rawByteLength(sessionId: string): Promise<number> {
    const [row] = await this.sql<{ storage: TranscriptStorage; len: number; ingested_bytes: string | number }[]>`
      SELECT storage, coalesce(length(raw_transcript), 0) AS len, ingested_bytes
      FROM sessions.sessions WHERE id = ${sessionId}::uuid
    `;
    if (!row) return 0;
    return row.storage === 'chunked' ? Number(row.ingested_bytes) : row.len;
  }

  /**
   * Parsed messages after `afterSeq` (exclusive) — the windowing sweep's raw
   * material for boundary decisions (message timestamps, rough per-message
   * size) that the serialized `[U]`/`[A]`/`[T]` text `messageRange` returns
   * doesn't carry.
   *
   * The returned array's contract has always been "a slice starting at
   * `afterSeq + 1`", not a globally-seq-indexed array — `messagesSince(id,
   * -1)` (today's only caller shape) happens to make those the same thing.
   * The chunked backend honors that same contract: it fetches only chunks
   * whose `msg_seq_end >= afterSeq + 1` (never a chunk that ends before
   * `afterSeq`), so a caller passing a large `afterSeq` into a session that
   * has grown far past it costs only the tail, not the whole chunk series.
   */
  async messagesSince(sessionId: string, afterSeq: number): Promise<TranscriptMessage[]> {
    const storage = await this.getStorage(sessionId);
    if (storage === null) return [];
    if (storage !== 'chunked') {
      const raw = await this.readFull(sessionId);
      if (!raw) return [];
      return parseMessages(raw).slice(afterSeq + 1);
    }

    const chunkRows = await this.sql<{ msg_seq_start: number; content: string }[]>`
      SELECT msg_seq_start, content FROM sessions.transcript_chunks
      WHERE session_id = ${sessionId}::uuid AND msg_seq_end >= ${afterSeq + 1}
      ORDER BY seq ASC
    `;
    if (chunkRows.length === 0) return [];
    const chunkBaseSeq = chunkRows[0]!.msg_seq_start;
    const bounded = chunkRows.map((r) => r.content).join('');
    // bounded's message index 0 == absolute seq chunkBaseSeq (chunkBaseSeq
    // may be < afterSeq + 1 when the earliest qualifying chunk also holds
    // some already-consumed messages before the boundary); slice the extra
    // off so index 0 of the RETURNED array is exactly afterSeq + 1, matching
    // the inline path's contract.
    return parseMessages(bounded).slice(Math.max(0, afterSeq + 1 - chunkBaseSeq));
  }
}
