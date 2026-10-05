/**
 * Background backfill of sessions.context_events for sessions ingested
 * before the context-timeline feature existed (specs/behaviors/
 * session-context-window.md: "Existing sessions are backfilled").
 *
 * Reads only already-stored `transcript_chunks` rows — never the transcript
 * file itself — one chunk at a time through a checkpoint this task owns
 * independently of live ingest's `parse_checkpoint` (see
 * `sessions.timeline_backfill_checkpoint`, added by migration 019). The
 * one-chunk-per-step loop itself is `chunk-backfill.ts`. This is
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
import { insertContextEvents } from './chunk-store.js';
import { runChunkBackfillCycle, type ChunkBackfillResult } from './chunk-backfill.js';

/** Default per-run byte budget — deliberately smaller than the ingest budget
 * (`SESSIONS_INGEST_BUDGET_BYTES`, 64 MiB): this is a lower-priority sweep of
 * historical content, not the live-ingest hot path. */
export const DEFAULT_TIMELINE_BACKFILL_BUDGET_BYTES = 16 * 1024 * 1024;

export type TimelineBackfillResult = ChunkBackfillResult;

/**
 * Run one backfill cycle: process chunks — one at a time, across however
 * many sessions it takes — until the byte budget is spent or every session
 * is caught up. Safe to call repeatedly and resumably; the stepping and the
 * handoff live in `chunk-backfill.ts`, shared with the prompt-events
 * backfill.
 */
export async function runTimelineBackfillCycle(
  sql: postgres.Sql,
  budgetBytes: number = DEFAULT_TIMELINE_BACKFILL_BUDGET_BYTES
): Promise<TimelineBackfillResult> {
  return runChunkBackfillCycle(
    sql,
    {
      columns: {
        done: 'timeline_backfill_done',
        nextChunkSeq: 'timeline_backfill_next_chunk_seq',
        checkpoint: 'timeline_backfill_checkpoint',
      },
      write: (tx, sessionId, delta) => insertContextEvents(tx, sessionId, delta.contextReadings, delta.compactions),
    },
    budgetBytes
  );
}
