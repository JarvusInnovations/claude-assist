import type postgres from 'postgres';
import {
  serializeTranscript,
  findInTranscript,
  readAround,
  serializeSince,
  serializeMessageRange,
  parseMessages,
  type SerializeTranscriptOptions,
  type FindOptions,
  type TranscriptMatch,
  type MessageWindow,
  type SerializedDelta,
  type MessageRangeResult,
} from './transcript.js';
import type { TranscriptMessage } from './types.js';

/**
 * The single choke point for reading `sessions.sessions.raw_transcript`.
 *
 * specs/behaviors/session-transcript-storage.md: "Readers take ranges" — every
 * consumer of transcript content goes through one of the range operations
 * below (full, a message range, head+tail within a byte budget, a window
 * around an anchor uuid, or grep) instead of loading a whole transcript to
 * use a part of it. That is what lets the storage backend change shape —
 * today one inline TEXT column, tomorrow append-only chunks — inside this
 * one module instead of across every call site.
 *
 * Today's inline backend still has to fetch the whole column for anything
 * that needs a full parse (a message range, around-anchor, grep, the
 * classification delta): a single TEXT value can't be sliced by message
 * boundary in SQL, and a chunked backend is what actually resolves a range to
 * only the chunks it covers. That is the plan's accepted carve-out — see
 * plans/transcript-read-layer.md. `readHeadTail` is the one shape that
 * already avoids it: `left`/`right` compute the sample in SQL, so an
 * oversized transcript never lands on the heap whole.
 */
export class TranscriptReader {
  constructor(private sql: postgres.Sql) {}

  /**
   * The full raw transcript text. `null` when no session with this id exists
   * (as opposed to `''`, an existing session with an empty archive).
   */
  async readFull(sessionId: string): Promise<string | null> {
    const [row] = await this.sql<{ raw_transcript: string | null }[]>`
      SELECT raw_transcript FROM sessions.sessions WHERE id = ${sessionId}::uuid
    `;
    if (!row) return null;
    return row.raw_transcript ?? '';
  }

  /**
   * Head+tail sample within a byte budget, computed in SQL (`left`/`right`)
   * so an oversized transcript never lands on the heap in full. Returns the
   * sample plus the column's true length so a caller can tell whether it was
   * sampled (`fullLength > budgetBytes`).
   */
  async readHeadTail(
    sessionId: string,
    budgetBytes: number
  ): Promise<{ raw: string; fullLength: number }> {
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

  /** A bounded message range `[fromSeq, toSeq]` (`toSeq` omitted reads to the end). */
  async messageRange(sessionId: string, fromSeq: number, toSeq?: number): Promise<MessageRangeResult> {
    const raw = await this.readFull(sessionId);
    return serializeMessageRange(raw ?? '', fromSeq, toSeq);
  }

  /**
   * The delta since a classification cursor — an open-ended message range
   * with a char budget and tail-keeping truncation policy (see
   * `serializeSince`). The session is assumed to already exist (callers hold
   * it from a prior select); a missing row degrades to an empty transcript
   * rather than throwing.
   */
  async since(
    sessionId: string,
    afterSeq: number,
    opts?: { maxChars?: number }
  ): Promise<SerializedDelta> {
    const raw = await this.readFull(sessionId);
    return serializeSince(raw ?? '', afterSeq, opts);
  }

  /**
   * A ± message window around an anchor uuid (the exploration follow-up to
   * `find`). `sessionFound: false` distinguishes a missing session from a
   * session whose transcript doesn't contain the anchor uuid (`window: null`).
   */
  async readAround(
    sessionId: string,
    anchorUuid: string,
    before: number,
    after: number
  ): Promise<{ sessionFound: boolean; window: MessageWindow | null }> {
    const raw = await this.readFull(sessionId);
    if (raw === null) return { sessionFound: false, window: null };
    return { sessionFound: true, window: readAround(raw, anchorUuid, before, after) };
  }

  /**
   * Windowed tool/text matches within one session — the grep path (#48).
   * `sessionFound: false` distinguishes a missing session (404) from a
   * session with zero matches (200, empty list).
   */
  async find(
    sessionId: string,
    opts: FindOptions
  ): Promise<{ sessionFound: boolean; matches: TranscriptMatch[] }> {
    const raw = await this.readFull(sessionId);
    if (raw === null) return { sessionFound: false, matches: [] };
    return { sessionFound: true, matches: findInTranscript(raw, opts) };
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
   * once: `raw_transcript` totals multiple GB across the archive.
   */
  async listSessionIdsWithContent(): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM sessions.sessions
      WHERE raw_transcript IS NOT NULL AND raw_transcript != ''
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
   * needed to count.
   */
  async rawByteLength(sessionId: string): Promise<number> {
    const [row] = await this.sql<{ len: number }[]>`
      SELECT coalesce(length(raw_transcript), 0) AS len
      FROM sessions.sessions WHERE id = ${sessionId}::uuid
    `;
    return row?.len ?? 0;
  }

  /**
   * Parsed messages after `afterSeq` (exclusive) — the windowing sweep's raw
   * material for boundary decisions (message timestamps, rough per-message
   * size) that the serialized `[U]`/`[A]`/`[T]` text `messageRange` returns
   * doesn't carry. Shares the read layer's accepted carve-out: today's inline
   * backend parses the whole column to slice it; a chunked backend resolves
   * this to just the bytes after `afterSeq` (see plans/transcript-read-layer.md).
   */
  async messagesSince(sessionId: string, afterSeq: number): Promise<TranscriptMessage[]> {
    const raw = await this.readFull(sessionId);
    if (!raw) return [];
    return parseMessages(raw).slice(afterSeq + 1);
  }
}
