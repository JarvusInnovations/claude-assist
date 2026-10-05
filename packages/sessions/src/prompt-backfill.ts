/**
 * Background backfill of sessions.prompt_events for sessions ingested before
 * prompt events existed (specs/behaviors/session-engagement.md: "Existing
 * sessions"). Same stepping and live-ingest handoff as the context-timeline
 * backfill — see `chunk-backfill.ts` and `timeline-backfill.ts` — against the
 * `prompt_backfill_*` columns added by migration 021.
 *
 * When a session's backlog is fully consumed, its activity ranges are rebuilt
 * from the complete set of prompt-event timestamps (prompt events and
 * activity ranges are derived from exactly the same turns). That repairs
 * ranges stored inverted by the pre-monotone merge, and any range that
 * stopped short of the transcript's last turn. `writeIngestCycle` folds each
 * later append onto the ranges stored at write time, so a cycle that read its
 * prior state before this rebuild cannot undo it.
 */

import type postgres from 'postgres';
import { insertPromptEvents } from './chunk-store.js';
import { applyActivityTimestamps } from './incremental-parser.js';
import { runChunkBackfillCycle, type ChunkBackfillResult } from './chunk-backfill.js';

/** Default per-run byte budget — matches the timeline backfill's. */
export const DEFAULT_PROMPT_BACKFILL_BUDGET_BYTES = 16 * 1024 * 1024;

export type PromptBackfillResult = ChunkBackfillResult;

/** Rebuild one session's activity ranges from its prompt events. Must run
 * under the session's row lock. */
export async function rebuildActivityRanges(tx: postgres.Sql, sessionId: string): Promise<void> {
  const rows = await tx<{ ts: Date }[]>`
    SELECT ts FROM sessions.prompt_events
    WHERE session_id = ${sessionId}::uuid AND ts IS NOT NULL
    ORDER BY ts
  `;
  const { ranges, lastActivityEnd } = applyActivityTimestamps(
    [],
    rows.map((r) => r.ts)
  );
  await tx`
    UPDATE sessions.sessions SET
      activity_ranges = ${tx.json(ranges as any)},
      parse_checkpoint = CASE
        WHEN parse_checkpoint IS NULL THEN NULL
        ELSE jsonb_set(parse_checkpoint, '{lastActivityEnd}', ${tx.json(lastActivityEnd as any)})
      END
    WHERE id = ${sessionId}::uuid
  `;
}

export async function runPromptBackfillCycle(
  sql: postgres.Sql,
  budgetBytes: number = DEFAULT_PROMPT_BACKFILL_BUDGET_BYTES
): Promise<PromptBackfillResult> {
  return runChunkBackfillCycle(
    sql,
    {
      columns: {
        done: 'prompt_backfill_done',
        nextChunkSeq: 'prompt_backfill_next_chunk_seq',
        checkpoint: 'prompt_backfill_checkpoint',
      },
      write: (tx, sessionId, delta) => insertPromptEvents(tx, sessionId, delta.promptEvents),
      onSessionComplete: rebuildActivityRanges,
    },
    budgetBytes
  );
}
