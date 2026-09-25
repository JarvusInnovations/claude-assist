import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { TranscriptMessage } from './types.js';

/**
 * Rolling window outlines for long-running sessions.
 *
 * specs/behaviors/session-outlines.md is the governing spec: a session over
 * the outline threshold is carved into windows by message range (closed by
 * message count, byte size, or time span, whichever trips first), each
 * window is summarized once, and the session outline is composed from the
 * window summaries instead of a single truncated pass over the whole
 * transcript.
 */

// ─────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────

export interface OutlineWindowConfig {
  /** Sessions with more messages than this are windowed instead of single-pass. */
  thresholdMessages: number;
  /** Sessions with a raw transcript larger than this (bytes) are windowed. */
  thresholdBytes: number;
  /** A window closes once it reaches this many messages. */
  maxMessages: number;
  /** A window closes once its accumulated raw size reaches this many bytes. */
  maxBytes: number;
  /** A window closes once it spans this many milliseconds. */
  maxSpanMs: number;
  /** Windows summarized per sweep, across all sessions — the backfill throttle. */
  sweepCap: number;
  /** A window's summarization stops being retried automatically past this many failures. */
  maxAttempts: number;
}

/**
 * Defaults, chosen to key off constants OutlineService already established
 * rather than inventing new numbers:
 *
 * - `thresholdBytes` (2 MiB) is exactly `OutlineService.RAW_TRANSCRIPT_FETCH_BUDGET`
 *   — the point where the single-pass path already starts sampling head+tail
 *   and silently dropping the middle. Windowing should take over right where
 *   that truncation would otherwise start losing content.
 * - `thresholdMessages` (400) covers a long single-sitting session comfortably
 *   while catching a persistent/multi-day session (a bot, a long-running loop)
 *   before it grows large enough to hit the byte threshold anyway.
 * - `maxMessages` (200) and `maxBytes` (500_000, a quarter of the fetch budget)
 *   keep one window's raw content — before serialization even shrinks it —
 *   well under `OutlineService.TRANSCRIPT_PROMPT_CHAR_BUDGET` (300_000) when
 *   it is summarized on its own.
 * - `maxSpanMs` (6 hours) bounds a slow-trickling persistent session to a
 *   summarizable time slice regardless of message or byte volume.
 * - `sweepCap` (20 windows/sweep) bounds first-time backfill cost: at the
 *   existing hourly outline cadence that trickles up to ~480 windows/day,
 *   spreading even a large pre-existing archive over days instead of bursting
 *   the model budget in one cycle.
 * - `maxAttempts` (5) mirrors `OutlineService.MAX_OUTLINE_ATTEMPTS`.
 */
export const DEFAULT_OUTLINE_WINDOW_CONFIG: OutlineWindowConfig = {
  thresholdMessages: 400,
  thresholdBytes: 2_000_000,
  maxMessages: 200,
  maxBytes: 500_000,
  maxSpanMs: 6 * 60 * 60 * 1000,
  sweepCap: 20,
  maxAttempts: 5,
};

// ─────────────────────────────────────────────────────────────────────────
// Pure boundary planning
// ─────────────────────────────────────────────────────────────────────────

export interface WindowBoundary {
  windowIndex: number;
  fromSeq: number;
  toSeq: number;
  fromTs: string | null;
  toTs: string | null;
  closed: boolean;
}

/** Rough, deterministic per-message size for window-size capping. Not exact bytes on disk — consistent and monotonic is what matters here. */
export function approxMessageBytes(msg: TranscriptMessage): number {
  return JSON.stringify(msg).length;
}

/**
 * Plan window boundaries over a run of messages that starts at `startSeq`
 * (the first seq not already covered by a closed window) and picks up right
 * where `startWindowIndex` (the count of windows already closed) leaves off.
 *
 * Pure and DB-free: a caller supplies only the messages since the last known
 * boundary (`TranscriptReader.messagesSince`), so cost is bounded by however
 * much is new, not by total session size — except unavoidably the first time
 * an existing long session is windowed at all.
 *
 * Walks the messages accumulating count/bytes/span for the window in
 * progress; whichever cap trips first closes it and starts the next. The
 * trailing partial run (nothing tripped) becomes the open tail boundary.
 * Returns `[]` for no messages.
 */
export function planWindows(
  startWindowIndex: number,
  startSeq: number,
  messages: ReadonlyArray<{ timestamp: string | null; approxBytes: number }>,
  config: Pick<OutlineWindowConfig, 'maxMessages' | 'maxBytes' | 'maxSpanMs'>
): WindowBoundary[] {
  const results: WindowBoundary[] = [];
  if (messages.length === 0) return results;

  let windowIndex = startWindowIndex;
  let segStart = 0;
  let segBytes = 0;
  let segStartTs: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    // Transcript lines without a timestamp (snapshots, summaries) arrive as
    // undefined at runtime despite the type; postgres.js rejects undefined
    // binds (UNDEFINED_VALUE), so normalize to null here.
    const ts = m.timestamp ?? null;
    if (segStartTs === null) segStartTs = ts;
    segBytes += m.approxBytes;

    const count = i - segStart + 1;
    const spanMs =
      segStartTs && ts ? Date.parse(ts) - Date.parse(segStartTs) : 0;

    const hitCap = count >= config.maxMessages || segBytes >= config.maxBytes || spanMs >= config.maxSpanMs;
    const isLast = i === messages.length - 1;

    if (hitCap) {
      results.push({
        windowIndex: windowIndex++,
        fromSeq: startSeq + segStart,
        toSeq: startSeq + i,
        fromTs: segStartTs,
        toTs: ts,
        closed: true,
      });
      segStart = i + 1;
      segBytes = 0;
      segStartTs = null;
    } else if (isLast) {
      results.push({
        windowIndex,
        fromSeq: startSeq + segStart,
        toSeq: startSeq + i,
        fromTs: segStartTs,
        toTs: ts,
        closed: false,
      });
    }
  }

  return results;
}

/** Whether a session's size warrants windowing instead of a single outline pass. */
export function isWindowedSession(
  messageCount: number,
  rawByteLength: number,
  config: Pick<OutlineWindowConfig, 'thresholdMessages' | 'thresholdBytes'>
): boolean {
  return messageCount > config.thresholdMessages || rawByteLength > config.thresholdBytes;
}

// ─────────────────────────────────────────────────────────────────────────
// Composition (summary of summaries)
// ─────────────────────────────────────────────────────────────────────────

export interface SummarizedWindowForCompose {
  windowIndex: number;
  fromTs: string | null;
  toTs: string | null;
  closed: boolean;
  summary: string;
}

/**
 * A stable signature over a session's currently-summarized windows. The
 * composed outline is only regenerated when this changes — a new window
 * closed, or the tail's summary changed — never on every sweep just because
 * the transcript grew. `sessions.sessions.outline_windows_hash` holds the
 * signature that produced the outline currently stored.
 */
export function windowsSignature(windows: ReadonlyArray<SummarizedWindowForCompose>): string {
  const material = windows
    .map((w) => `${w.windowIndex}:${w.closed ? 'c' : 'o'}:${w.summary}`)
    .join('\u0001');
  return createHash('md5').update(material).digest('hex');
}

/** Build the "summary of summaries" prompt composing the session outline from window summaries. */
export function buildComposePrompt(
  projectPath: string | null,
  gitBranch: string | null,
  windows: ReadonlyArray<SummarizedWindowForCompose>
): string {
  const sections = windows
    .map((w) => {
      const span = w.fromTs && w.toTs ? `${w.fromTs} → ${w.toTs}` : 'unknown time span';
      const state = w.closed ? '' : ' (in progress)';
      return `<window index="${w.windowIndex}" span="${span}"${state}>\n${w.summary}\n</window>`;
    })
    .join('\n\n');

  return `Compose a single outline for this long-running Claude Code session from its
chronological window summaries below. Each window already summarizes a
contiguous slice of the session; synthesize them into one coherent account
of the whole session so far — do not just concatenate them.

SESSION:
- Project: ${projectPath ?? 'unknown'}
- Branch: ${gitBranch ?? 'unknown'}

WINDOW SUMMARIES (chronological):
${sections}

Respond with exactly this format:
<title>[5-10 word concise title describing the main task]</title>
<summary>
Task: [1-2 sentence description of what the session as a whole accomplished or is working toward]

Outcome: [1-2 sentence summary of where things stand]

- [key topic or task covered]
- [key topic or task covered]
</summary>`;
}

/** Build the prompt to summarize a single window's messages. */
export function buildWindowPrompt(
  projectPath: string | null,
  gitBranch: string | null,
  windowIndex: number,
  closed: boolean,
  serializedWindow: string
): string {
  return `Summarize this slice (window ${windowIndex}${closed ? '' : ', still in progress'}) of a
longer Claude Code session. This is one segment of a larger conversation, not
the whole thing — describe only what happened in this slice.

SESSION:
- Project: ${projectPath ?? 'unknown'}
- Branch: ${gitBranch ?? 'unknown'}

TRANSCRIPT SLICE:
${serializedWindow}

Respond with a concise paragraph (3-6 sentences) describing what was done in
this slice. No tags, no preamble.`;
}

// ─────────────────────────────────────────────────────────────────────────
// Persistence — sessions.outline_windows
// ─────────────────────────────────────────────────────────────────────────

export interface OutlineWindowRow {
  id: string;
  session_id: string;
  window_index: number;
  from_seq: number;
  to_seq: number;
  from_ts: string | null;
  to_ts: string | null;
  closed_at: string | null;
  status: 'pending' | 'summarizing' | 'summarized' | 'failed';
  summary: string | null;
  content_hash: string | null;
  model: string | null;
  attempts: number;
  summarized_at: string | null;
}

/**
 * The DB half of windowed outlines. A hand-rolled claim/lease over
 * `sessions.outline_windows` rather than `packages/core`'s generic
 * `createLeaseQueue` (specs/behaviors/scheduled-work-leases.md) — deliberate,
 * not an oversight: that helper's `complete()` never resets `attempts`, which
 * is correct for a queue of one-shot rows but wrong here. The *open tail*
 * row is claimed and completed over and over across a session's life (every
 * sweep that finds new content re-summarizes it), and each successful
 * completion should clear its failure count, not carry it toward the cap.
 * Closed windows behave like the generic queue's one-shot case (claim once,
 * terminal `summarized`); the tail doesn't, so one mechanism serves both,
 * with completion resetting `attempts` to 0 only on success.
 *
 * Claiming is per-row (`claimOne`), not a batch claim across sessions: the
 * caller (`OutlineService`) already iterates sessions one at a time under a
 * shared per-sweep budget, so the atomic guard only needs to protect one row
 * against a second process (a manual-trigger sweep racing the scheduled one)
 * — not to pick a batch out of the whole table.
 */
export class OutlineWindowStore {
  constructor(private sql: postgres.Sql) {}

  /** All windows for a session, oldest first. */
  async listWindows(sessionId: string): Promise<OutlineWindowRow[]> {
    return this.sql<OutlineWindowRow[]>`
      SELECT id, session_id, window_index, from_seq, to_seq, from_ts, to_ts,
             closed_at, status, summary, content_hash, model, attempts, summarized_at
      FROM sessions.outline_windows
      WHERE session_id = ${sessionId}::uuid
      ORDER BY window_index ASC
    `;
  }

  /**
   * Where boundary planning should resume for a session: the highest `to_seq`
   * among CLOSED windows (-1 when none exist yet, so planning starts at seq
   * 0) and how many closed windows already exist (the next window's index).
   */
  async boundaryState(sessionId: string): Promise<{ lastClosedToSeq: number; closedCount: number }> {
    const [row] = await this.sql<{ to_seq: number | null; closed_count: number }[]>`
      SELECT MAX(to_seq) AS to_seq, COUNT(*)::int AS closed_count
      FROM sessions.outline_windows
      WHERE session_id = ${sessionId}::uuid AND closed_at IS NOT NULL
    `;
    return { lastClosedToSeq: row?.to_seq ?? -1, closedCount: row?.closed_count ?? 0 };
  }

  /**
   * Write a planned boundary. Immutable once closed: the `WHERE closed_at IS
   * NULL` guard means a re-plan can extend or close the still-open tail, but
   * can never rewrite a window that's already closed.
   */
  async upsertBoundary(sessionId: string, b: WindowBoundary): Promise<void> {
    await this.sql`
      INSERT INTO sessions.outline_windows
        (session_id, window_index, from_seq, to_seq, from_ts, to_ts, closed_at, status)
      VALUES (
        ${sessionId}::uuid, ${b.windowIndex}, ${b.fromSeq}, ${b.toSeq},
        ${b.fromTs}, ${b.toTs},
        CASE WHEN ${b.closed} THEN NOW() ELSE NULL END,
        'pending'
      )
      ON CONFLICT (session_id, window_index) DO UPDATE SET
        to_seq = EXCLUDED.to_seq,
        to_ts = EXCLUDED.to_ts,
        closed_at = CASE
          WHEN sessions.outline_windows.closed_at IS NOT NULL THEN sessions.outline_windows.closed_at
          ELSE EXCLUDED.closed_at
        END
      WHERE sessions.outline_windows.closed_at IS NULL
    `;
  }

  /**
   * Atomically claim one pending window by id. `false` means someone else
   * (another process's sweep, or a manual trigger racing the scheduled one)
   * already claimed it — the caller moves on without spending its budget
   * slot on a window it didn't actually get.
   */
  async claimOne(id: string, ownerId: string, leaseMs: number): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE sessions.outline_windows
      SET status = 'summarizing',
          lease_owner = ${ownerId},
          lease_expires_at = NOW() + (${leaseMs}::text || ' milliseconds')::interval
      WHERE id = ${id} AND status = 'pending'
      RETURNING id
    `;
    return rows.length > 0;
  }

  /** Release a claimed window without summarizing it — its content hasn't changed since last time. */
  async releaseUnchanged(id: string): Promise<void> {
    await this.sql`
      UPDATE sessions.outline_windows
      SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ${id}
    `;
  }

  /**
   * Record a successful summarization. A closed window goes terminal
   * (`summarized`, never claimed again — immutable from here on); the open
   * tail cycles back to `pending` with `attempts` reset, ready for a future
   * sweep once new content changes its `content_hash` again.
   */
  async completeSummary(
    id: string,
    args: { summary: string; model: string; contentHash: string; closed: boolean }
  ): Promise<void> {
    await this.sql`
      UPDATE sessions.outline_windows
      SET status = ${args.closed ? 'summarized' : 'pending'},
          summary = ${args.summary},
          model = ${args.model},
          content_hash = ${args.contentHash},
          summarized_at = NOW(),
          attempts = 0,
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE id = ${id}
    `;
  }

  /** Record a failed summarization attempt; terminal (`failed`) once `maxAttempts` is reached. */
  async failSummary(id: string, error: string, maxAttempts: number): Promise<void> {
    await this.sql`
      UPDATE sessions.outline_windows
      SET attempts = attempts + 1,
          last_error = ${error.slice(0, 2000)},
          lease_owner = NULL,
          lease_expires_at = NULL,
          status = CASE WHEN attempts + 1 >= ${maxAttempts} THEN 'failed' ELSE 'pending' END
      WHERE id = ${id}
    `;
  }

  /** Return leases stuck past their expiry (a crashed sweep) to `pending`. */
  async reclaimExpired(): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE sessions.outline_windows
      SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
      WHERE status = 'summarizing' AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()
      RETURNING id
    `;
    return rows.length;
  }
}
