/**
 * Background backfill of sessions.context_events for sessions ingested
 * before the context-timeline feature existed (specs/behaviors/
 * session-context-window.md: "Existing sessions are backfilled").
 *
 * Reads only already-stored `transcript_chunks` rows — never the transcript
 * file itself — one chunk at a time through a checkpoint this task owns
 * independently of live ingest's `parse_checkpoint` (see
 * `sessions.timeline_backfill_checkpoint`, added by migration 019). This is
 * what "never concatenating a session's chunks" means in practice: even a
 * 500 MB, 500-chunk session is processed 8 MiB at a time, and progress
 * (`timeline_backfill_next_chunk_seq` + the checkpoint) is durable between
 * calls, so a run can stop at any point and the next one resumes exactly
 * where it left off.
 *
 * **The live-ingest handoff.** `chunk-store.ts#writeIngestCycle` writes a
 * cycle's own context_events only once `timeline_backfill_done` is true for
 * that session. This module is the other half: it walks a session's chunks
 * forward until none remain beyond its cursor, then flips the flag — always
 * under `SELECT ... FOR UPDATE` on the session row as the *first* statement
 * in the deciding transaction, the same lock writeIngestCycle takes before
 * reading the flag. Whichever transaction (a live-ingest append, or this
 * task's "no chunks left, mark done" step) commits first is what the other
 * sees, so the flag flips exactly once and neither side double-derives nor
 * drops a chunk's events. See the doc comment on `writeIngestCycle` in
 * `chunk-store.ts` for the symmetric half of this argument.
 *
 * This module assumes single-flight execution (the scheduler registers it
 * under the standard advisory lock — specs/behaviors/scheduled-work-leases.md)
 * so it does not itself need a lease beyond the per-session row lock above.
 */

import type postgres from 'postgres';
import { feed, EMPTY_CHECKPOINT, type ParseCheckpoint } from './incremental-parser.js';
import { splitLinesWithTerminators } from './chunked-ingest.js';
import { insertContextEvents } from './chunk-store.js';

/** Default per-run byte budget — deliberately smaller than the ingest budget
 * (`SESSIONS_INGEST_BUDGET_BYTES`, 64 MiB): this is a lower-priority sweep of
 * historical content, not the live-ingest hot path. */
export const DEFAULT_TIMELINE_BACKFILL_BUDGET_BYTES = 16 * 1024 * 1024;

export interface TimelineBackfillResult {
  /** Sessions whose backlog was fully consumed this run (flag flipped to true). */
  sessionsCompleted: number;
  /** Individual transcript_chunks rows fed through the parser this run. */
  chunksProcessed: number;
  bytesProcessed: number;
}

interface StepResult {
  completed: boolean;
  chunkProcessed: boolean;
  bytesConsumed: number;
}

/**
 * Process exactly one step for one session: either feed its next stored
 * chunk and advance the cursor, or — if no chunk remains beyond the cursor —
 * mark it done. Everything happens in one transaction so a crash between the
 * read and the write never double-derives or loses a chunk's events.
 */
async function backfillOneStep(sql: postgres.Sql, sessionId: string): Promise<StepResult> {
  return sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as postgres.Sql;

    // First touch of this session's row in this transaction — see the
    // module doc comment for why the lock ordering here is load-bearing.
    const [session] = await tx<
      { timeline_backfill_next_chunk_seq: number; timeline_backfill_checkpoint: ParseCheckpoint | null }[]
    >`
      SELECT timeline_backfill_next_chunk_seq, timeline_backfill_checkpoint
      FROM sessions.sessions
      WHERE id = ${sessionId}::uuid
      FOR UPDATE
    `;
    if (!session) return { completed: false, chunkProcessed: false, bytesConsumed: 0 };

    const nextSeq = session.timeline_backfill_next_chunk_seq;
    const [chunk] = await tx<{ content: string }[]>`
      SELECT content FROM sessions.transcript_chunks
      WHERE session_id = ${sessionId}::uuid AND seq = ${nextSeq}
    `;

    if (!chunk) {
      // No chunk waiting beyond our cursor, under this row's lock — caught
      // up. A live-ingest cycle concurrently appending a new chunk is
      // blocked on this same lock until this transaction commits, and will
      // then see timeline_backfill_done = true and take over writing events
      // for its own new content itself.
      await tx`UPDATE sessions.sessions SET timeline_backfill_done = true WHERE id = ${sessionId}::uuid`;
      return { completed: true, chunkProcessed: false, bytesConsumed: 0 };
    }

    const checkpoint = session.timeline_backfill_checkpoint ?? EMPTY_CHECKPOINT;
    const lines = splitLinesWithTerminators(chunk.content);
    const { checkpoint: nextCheckpoint, delta } = feed(checkpoint, lines);

    await insertContextEvents(tx, sessionId, delta.contextReadings, delta.compactions);

    await tx`
      UPDATE sessions.sessions SET
        timeline_backfill_next_chunk_seq = ${nextSeq + 1},
        timeline_backfill_checkpoint = ${tx.json(nextCheckpoint as any)}
      WHERE id = ${sessionId}::uuid
    `;

    return { completed: false, chunkProcessed: true, bytesConsumed: Buffer.byteLength(chunk.content, 'utf8') };
  });
}

/**
 * Run one backfill cycle: process chunks — one at a time, across however
 * many sessions it takes — until the byte budget is spent or every session
 * is caught up. Safe to call repeatedly and resumably; all progress is
 * durable per session between calls (specs/behaviors/scheduled-work-leases.md
 * doesn't require a lease here beyond the per-step row lock, since the
 * scheduler's own advisory lock already keeps this single-flight).
 */
export async function runTimelineBackfillCycle(
  sql: postgres.Sql,
  budgetBytes: number = DEFAULT_TIMELINE_BACKFILL_BUDGET_BYTES
): Promise<TimelineBackfillResult> {
  let bytesProcessed = 0;
  let chunksProcessed = 0;
  let sessionsCompleted = 0;

  // Guards against spinning forever within one cycle: `ORDER BY id LIMIT 1`
  // deterministically returns the same session first every time, so if a
  // step neither consumes budget nor completes the session (only possible if
  // it has zero chunks currently stored — e.g. mid-first-ingest), retrying
  // it immediately would loop without end.
  let stalledSessionId: string | null = null;

  while (bytesProcessed < budgetBytes) {
    const [session] = await sql<{ id: string }[]>`
      SELECT id FROM sessions.sessions
      WHERE timeline_backfill_done = false
      ORDER BY id
      LIMIT 1
    `;
    if (!session) break; // every session is caught up
    if (session.id === stalledSessionId) break;

    const result = await backfillOneStep(sql, session.id);
    if (result.completed) sessionsCompleted++;
    if (result.chunkProcessed) {
      chunksProcessed++;
      bytesProcessed += result.bytesConsumed;
      stalledSessionId = null;
    } else if (!result.completed) {
      stalledSessionId = session.id;
    }
  }

  return { sessionsCompleted, chunksProcessed, bytesProcessed };
}
