import type postgres from 'postgres';
import {
  findInMessageSlice,
  TranscriptSerializer,
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
  serializeTranscriptUntruncated,
  truncateTranscriptTail,
  MAX_TRANSCRIPT_CHARS,
} from './transcript.js';
import type { TranscriptMessage } from './types.js';

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
 * Chunks (`sessions.transcript_chunks` + `sessions.transcript_messages`) are
 * the only archive — every session is ingested this way (the legacy inline
 * `raw_transcript` column and its `catching_up` transition were retired once
 * the one-time backfill converted every pre-chunking row; see migration 017).
 * Every range operation — `readAround`, `find`, `messageRange`, `since`,
 * `messagesSince`, `rawByteLength` — resolves to only the chunks the
 * requested range touches, via the message index (`transcript_messages`) and
 * each chunk's own `[msg_seq_start, msg_seq_end]`, never by concatenating the
 * whole chunk series. A time-windowed `serialize` resolves its window to
 * chunks by their first timestamps, and `find` walks its range a chunk at a
 * time; both hold a bounded number of chunks ("Reads hold bounded memory").
 * `readFull` and `readRawMessages` are the exception: they are inherently
 * whole-transcript operations (a caller asking for everything), so they still
 * concatenate every chunk.
 *
 * A range read rebases the pure functions in `transcript.ts` (which parse
 * from index 0 = seq 0) onto whatever chunks were actually fetched: it
 * fetches only chunks overlapping the requested seq range, computes
 * `chunkBaseSeq` (the absolute seq the fetched slice's first message
 * actually starts at), calls the pure function with seq arguments shifted by
 * `-chunkBaseSeq`, then shifts the result's `seqStart`/`seqEnd` back by
 * `+chunkBaseSeq` before returning — so every caller-visible seq stays an
 * absolute session seq.
 */

/** `msg_seq_start`/`msg_seq_end` are Postgres INTEGER (int4) columns, so any
 * "no upper bound" sentinel used in a comparison against them has to fit
 * int4 — `Number.MAX_SAFE_INTEGER` overflows it. */
const INT4_MAX = 2147483647;

/** Chunks fetched per step when reading a transcript backwards (up to ~32 MB). */
const RECENT_CHUNK_BATCH = 4;

/** Characters of a chunk's head read to find its first timestamp. A line can be
 * long (a tool result), so this is generous, but it never pulls a whole chunk. */
const CHUNK_PROBE_CHARS = 256 * 1024;

export class TranscriptReader {
  constructor(private sql: postgres.Sql) {}

  /** `true` if a session with this id exists. */
  private async sessionExists(sessionId: string): Promise<boolean> {
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM sessions.sessions WHERE id = ${sessionId}::uuid
    `;
    return !!row;
  }

  /** Concatenate every chunk's content, in order. */
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
    if (!(await this.sessionExists(sessionId))) return null;
    return this.readFullChunked(sessionId);
  }

  /**
   * Head+tail sample within a byte budget: fetches only the boundary chunks
   * (by byte range), never the whole chunk series. Returns the sample plus
   * the transcript's true length so a caller can tell whether it was sampled
   * (`fullLength > budgetBytes`).
   */
  async readHeadTail(
    sessionId: string,
    budgetBytes: number
  ): Promise<{ raw: string; fullLength: number }> {
    if (!(await this.sessionExists(sessionId))) return { raw: '', fullLength: 0 };

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
    // A time-windowed request reads only the chunks covering its window. An
    // unwindowed one only ever shows the most recent MAX_TRANSCRIPT_CHARS, so
    // read chunks backwards from the end until that much has been serialized.
    if (opts?.after || opts?.before) {
      return this.serializeWindow(sessionId, opts);
    }
    return this.serializeRecent(sessionId, opts);
  }

  /**
   * A time-windowed serialization holding one chunk at a time
   * (session-transcript-storage.md, "Time windows resolve to chunks"): binary
   * search the chunks' first timestamps for the window's first and last
   * chunk, widen one chunk each side for boundary skew, then stream those
   * chunks oldest-first through a serializer that keeps only the tail it
   * will return. Same output as filtering the whole transcript.
   */
  private async serializeWindow(sessionId: string, opts: SerializeTranscriptOptions): Promise<string> {
    const chunks = await this.chunkIndex(sessionId);
    if (chunks.length === 0) return '';

    const firstTs = new Map<number, number | null>();
    const probe = async (i: number): Promise<number | null> => {
      if (!firstTs.has(i)) firstTs.set(i, await this.chunkFirstTimestamp(sessionId, chunks[i]!.seq));
      return firstTs.get(i)!;
    };

    // The last chunk starting at or before `after`: the window can't begin
    // before it. A chunk with no readable timestamp is treated as inside the
    // window, which only ever widens the read.
    let low = 0;
    if (opts.after) {
      const afterMs = opts.after.getTime();
      let lo = 0;
      let hi = chunks.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const ts = await probe(mid);
        if (ts !== null && ts <= afterMs) lo = mid;
        else hi = mid - 1;
      }
      low = Math.max(0, lo - 1);
    }

    // The last chunk starting at or before `before`: nothing after it can be
    // in the window.
    let high = chunks.length - 1;
    if (opts.before) {
      const beforeMs = opts.before.getTime();
      let lo = low;
      let hi = chunks.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const ts = await probe(mid);
        if (ts === null || ts <= beforeMs) lo = mid;
        else hi = mid - 1;
      }
      high = Math.min(chunks.length - 1, lo + 1);
    }

    const serializer = new TranscriptSerializer(opts, MAX_TRANSCRIPT_CHARS);
    for (let i = low; i <= high; i++) {
      const [row] = await this.chunkContents(sessionId, chunks[i]!.seq, chunks[i]!.seq);
      if (row) serializer.push(row.content);
    }
    return truncateTranscriptTail(serializer.text(), serializer.earlierOmitted);
  }

  /** Every chunk's seq and message range, in order, without content. */
  private async chunkIndex(
    sessionId: string
  ): Promise<{ seq: number; msg_seq_start: number; msg_seq_end: number }[]> {
    return this.sql<{ seq: number; msg_seq_start: number; msg_seq_end: number }[]>`
      SELECT seq, msg_seq_start, msg_seq_end FROM sessions.transcript_chunks
      WHERE session_id = ${sessionId}::uuid
      ORDER BY seq ASC
    `;
  }

  /** Chunks `[lowSeq, highSeq]` with content, in order. */
  private async chunkContents(
    sessionId: string,
    lowSeq: number,
    highSeq: number
  ): Promise<{ msg_seq_start: number; content: string }[]> {
    return this.sql<{ msg_seq_start: number; content: string }[]>`
      SELECT msg_seq_start, content FROM sessions.transcript_chunks
      WHERE session_id = ${sessionId}::uuid AND seq BETWEEN ${lowSeq} AND ${highSeq}
      ORDER BY seq ASC
    `;
  }

  /**
   * The first message timestamp in a chunk, read from a bounded head of its
   * content so a probe never pulls a whole chunk. Complete lines are parsed in
   * order; a head with no complete timestamped line yields `null`.
   */
  private async chunkFirstTimestamp(sessionId: string, seq: number): Promise<number | null> {
    const [row] = await this.sql<{ head: string }[]>`
      SELECT left(content, ${CHUNK_PROBE_CHARS}) AS head FROM sessions.transcript_chunks
      WHERE session_id = ${sessionId}::uuid AND seq = ${seq}
    `;
    if (!row) return null;
    const lines = row.head.split('\n');
    // The last piece may be cut mid-line unless the head is the whole chunk.
    const complete = row.head.length < CHUNK_PROBE_CHARS ? lines : lines.slice(0, -1);
    for (const line of complete) {
      if (!line.trim()) continue;
      try {
        const ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
        if (typeof ts === 'string') {
          const ms = Date.parse(ts);
          if (!Number.isNaN(ms)) return ms;
        }
      } catch {
        // malformed line: keep looking
      }
    }
    return null;
  }

  /** Whether a session with this id exists. */
  async exists(sessionId: string): Promise<boolean> {
    return this.sessionExists(sessionId);
  }

  private async serializeRecent(sessionId: string, opts?: SerializeTranscriptOptions): Promise<string> {
    const [top] = await this.sql<{ max_seq: number | null }[]>`
      SELECT max(seq) AS max_seq FROM sessions.transcript_chunks WHERE session_id = ${sessionId}::uuid
    `;
    if (top?.max_seq === null || top?.max_seq === undefined) return '';
    // Chunks are cut at line boundaries, so any suffix of the chunk series is
    // a well-formed JSONL tail. Walk backwards measuring each batch's
    // serialized size once (linear, not re-serializing the growing suffix),
    // then serialize the chosen suffix once, in order, so cross-line state
    // (a question and its later answer) renders exactly as a full read would.
    const parts: string[] = [];
    let nextSeq = top.max_seq;
    let measured = 0;
    while (nextSeq >= 0 && measured < MAX_TRANSCRIPT_CHARS) {
      const lowSeq = Math.max(0, nextSeq - RECENT_CHUNK_BATCH + 1);
      const rows = await this.sql<{ content: string }[]>`
        SELECT content FROM sessions.transcript_chunks
        WHERE session_id = ${sessionId}::uuid AND seq BETWEEN ${lowSeq} AND ${nextSeq}
        ORDER BY seq ASC
      `;
      const batch = rows.map((r) => r.content).join('');
      measured += serializeTranscriptUntruncated(batch, opts).length;
      parts.unshift(batch);
      nextSeq = lowSeq - 1;
    }
    const serialized = serializeTranscriptUntruncated(parts.join(''), opts);
    return truncateTranscriptTail(serialized, nextSeq >= 0);
  }

  /**
   * A bounded message range `[fromSeq, toSeq]` (`toSeq` omitted reads to the
   * end). Fetches only chunks whose `[msg_seq_start, msg_seq_end]` overlaps
   * the request, never the whole chunk series.
   */
  async messageRange(sessionId: string, fromSeq: number, toSeq?: number): Promise<MessageRangeResult> {
    if (!(await this.sessionExists(sessionId))) return { text: '', seqStart: -1, seqEnd: -1, count: 0 };

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
   * Never fetches a chunk that ends before `afterSeq` (the hard floor), and
   * — since `serializeSince` keeps only the tail once past the char budget
   * anyway — walks chunks from the newest backward, adding one at a time and
   * re-serializing the growing slice, stopping as soon as the serialized
   * text reaches the char budget (or every qualifying chunk has been
   * included). This is what guarantees the result is never short of what
   * the caller asked for: raw JSONL bytes run several times the serialized
   * char count (JSON's per-message overhead — uuids, timestamps, envelope
   * keys), so any fixed raw-byte-to-char ratio either under-fetches on dense
   * content or over-fetches on sparse content; checking the actual
   * serialized length after each chunk needs neither guess. In the case
   * this exists for — a session that grew by hundreds of MB since
   * `afterSeq` — the newest one or two chunks alone almost always already
   * exceed the char budget, so this stops immediately; it degrades to
   * walking every qualifying chunk only when the content since `afterSeq`
   * genuinely doesn't reach the budget at all, the same case where
   * `serializeSince` itself would return everything, untruncated.
   */
  async since(
    sessionId: string,
    afterSeq: number,
    opts?: { maxChars?: number }
  ): Promise<SerializedDelta> {
    if (!(await this.sessionExists(sessionId))) {
      return { text: '', seqStart: -1, seqEnd: afterSeq, count: 0, truncated: false };
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

    const pickedDesc: Array<{ msg_seq_start: number; content: string }> = [];
    let droppedOlderChunks = false;
    let result: SerializedDelta = { text: '', seqStart: -1, seqEnd: afterSeq, count: 0, truncated: false };
    let chunkBaseSeq = afterSeq + 1;
    for (let i = 0; i < qualifying.length; i++) {
      pickedDesc.push(qualifying[i]!);
      chunkBaseSeq = pickedDesc[pickedDesc.length - 1]!.msg_seq_start;
      const bounded = [...pickedDesc].reverse().map((r) => r.content).join('');
      result = serializeSince(bounded, afterSeq - chunkBaseSeq, opts);
      if (result.text.length >= maxChars) {
        droppedOlderChunks = i < qualifying.length - 1;
        break;
      }
    }

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
   * Resolves the anchor's seq via `transcript_messages` and fetches only the
   * chunks whose message range overlaps `[seq-before, seq+after]` — never
   * the whole chunk series.
   */
  async readAround(
    sessionId: string,
    anchorUuid: string,
    before: number,
    after: number
  ): Promise<{ sessionFound: boolean; window: MessageWindow | null }> {
    if (!(await this.sessionExists(sessionId))) return { sessionFound: false, window: null };

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
   * Resolves `afterUuid`/`beforeUuid` (if given) to a seq range via
   * `transcript_messages` and greps only the chunks that range overlaps; an
   * unbounded search (no afterUuid/beforeUuid) still has to cover the whole
   * transcript, so it fetches every chunk.
   */
  async find(
    sessionId: string,
    opts: FindOptions
  ): Promise<{ sessionFound: boolean; matches: TranscriptMatch[] }> {
    if (!(await this.sessionExists(sessionId))) return { sessionFound: false, matches: [] };

    // Sentinel bounds rather than conditional SQL fragments: an absent
    // afterUuid/beforeUuid just means "no lower/upper bound", so the same
    // unconditional query shape covers a bounded or fully unbounded search.
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

    // Walk the range a chunk at a time, oldest first, stopping at the limit
    // (session-transcript-storage.md, "Search stops at its limit"). Each
    // chunk is parsed with one neighbour each side so a match at a chunk edge
    // still gets its context window; only messages in the chunk itself are
    // matched, so none is matched twice.
    const index = await this.chunkIndex(sessionId);
    const inRange = index
      .map((c, i) => ({ ...c, i }))
      .filter((c) => c.msg_seq_end >= seqStart && c.msg_seq_start <= seqEnd);
    if (inRange.length === 0) return { sessionFound: true, matches: [] };
    const lastSeq = index[index.length - 1]!.msg_seq_end;
    const limit = opts.limit ?? 10;

    // Parsed chunks by index, holding only the current chunk and its
    // neighbours, so each chunk is fetched and parsed once as the walk slides
    // forward. Chunks end at line boundaries, so parsing them separately and
    // concatenating equals parsing their joined text.
    const parsed = new Map<number, { base: number; msgs: TranscriptMessage[] }>();
    const parsedChunk = async (i: number) => {
      let entry = parsed.get(i);
      if (!entry) {
        const seq = index[i]!.seq;
        const [row] = await this.chunkContents(sessionId, seq, seq);
        entry = { base: row?.msg_seq_start ?? index[i]!.msg_seq_start, msgs: row ? parseMessages(row.content) : [] };
        parsed.set(i, entry);
      }
      return entry;
    };

    const matches: TranscriptMatch[] = [];
    for (const chunk of inRange) {
      if (matches.length >= limit) break;
      for (const held of parsed.keys()) {
        if (held < chunk.i - 1) parsed.delete(held);
      }
      const neighbours: { base: number; msgs: TranscriptMessage[] }[] = [];
      for (let i = Math.max(0, chunk.i - 1); i <= Math.min(index.length - 1, chunk.i + 1); i++) {
        neighbours.push(await parsedChunk(i));
      }
      const found = findInMessageSlice(
        neighbours.flatMap((n) => n.msgs),
        { ...opts, limit: limit - matches.length },
        {
          base: neighbours[0]!.base,
          from: Math.max(seqStart, chunk.msg_seq_start),
          to: Math.min(seqEnd, chunk.msg_seq_end),
          lastSeq,
        }
      );
      matches.push(...found);
    }
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
      SELECT DISTINCT session_id AS id FROM sessions.transcript_chunks
    `;
    return rows.map((r) => r.id);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Added for windowed outlines (specs/behaviors/session-outlines.md).
  // Grouped at the end per the read layer's convention: existing methods
  // above are unchanged, these are additions.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * A session's archived byte length without fetching content — lets a
   * caller decide whether a session is large enough to window without
   * paying to fetch bytes it only needed to count (see `outline.ts`'s
   * `isWindowed`).
   */
  async rawByteLength(sessionId: string): Promise<number> {
    const [row] = await this.sql<{ ingested_bytes: string | number }[]>`
      SELECT ingested_bytes FROM sessions.sessions WHERE id = ${sessionId}::uuid
    `;
    return row ? Number(row.ingested_bytes) : 0;
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
   * Fetches only chunks whose `msg_seq_end >= afterSeq + 1` (never a chunk
   * that ends before `afterSeq`), so a caller passing a large `afterSeq`
   * into a session that has grown far past it costs only the tail, not the
   * whole chunk series.
   */
  async messagesSince(sessionId: string, afterSeq: number, limit?: number): Promise<TranscriptMessage[]> {
    if (!(await this.sessionExists(sessionId))) return [];

    // With a limit, stop at the last chunk that can hold seq afterSeq + limit,
    // so a caller asking for a bounded window never reads the rest of a large
    // transcript.
    const chunkRows =
      limit === undefined
        ? await this.sql<{ msg_seq_start: number; content: string }[]>`
            SELECT msg_seq_start, content FROM sessions.transcript_chunks
            WHERE session_id = ${sessionId}::uuid AND msg_seq_end >= ${afterSeq + 1}
            ORDER BY seq ASC
          `
        : await this.sql<{ msg_seq_start: number; content: string }[]>`
            SELECT msg_seq_start, content FROM sessions.transcript_chunks
            WHERE session_id = ${sessionId}::uuid AND msg_seq_end >= ${afterSeq + 1}
              AND msg_seq_start <= ${afterSeq + limit}
            ORDER BY seq ASC
          `;
    if (chunkRows.length === 0) return [];
    const chunkBaseSeq = chunkRows[0]!.msg_seq_start;
    const bounded = chunkRows.map((r) => r.content).join('');
    // bounded's message index 0 == absolute seq chunkBaseSeq (chunkBaseSeq
    // may be < afterSeq + 1 when the earliest qualifying chunk also holds
    // some already-consumed messages before the boundary); slice the extra
    // off so index 0 of the RETURNED array is exactly afterSeq + 1, matching
    // this method's contract.
    const start = Math.max(0, afterSeq + 1 - chunkBaseSeq);
    return parseMessages(bounded).slice(start, limit === undefined ? undefined : start + limit);
  }
}
