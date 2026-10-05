/**
 * The resumable, one-chunk-per-step backfill loop shared by every derivation
 * that has to catch up on sessions ingested before it existed
 * (`timeline-backfill.ts`, `prompt-backfill.ts`). Each derivation owns three
 * columns on `sessions.sessions` — a done flag, a chunk cursor, and an
 * incremental-parser checkpoint independent of live ingest's
 * `parse_checkpoint` — and supplies what to write from each chunk's delta.
 *
 * The handoff with live ingest is documented in full on
 * `timeline-backfill.ts` and `chunk-store.ts#writeIngestCycle`; this module
 * is its mechanism: every step takes `SELECT ... FOR UPDATE` on the session
 * row as its first statement, so the "no chunks left, mark done" decision and
 * a concurrent live append are serialized by Postgres.
 */

import type postgres from 'postgres';
import { feed, EMPTY_CHECKPOINT, type ParseCheckpoint, type ParseDelta } from './incremental-parser.js';
import { splitLinesWithTerminators } from './chunked-ingest.js';

export interface ChunkBackfillSpec {
  /** This derivation's bookkeeping columns on `sessions.sessions`. Fixed
   * identifiers from code, never caller input. */
  columns: { done: string; nextChunkSeq: string; checkpoint: string };
  /** Persist what this derivation takes from one chunk's parse delta. */
  write: (tx: postgres.Sql, sessionId: string, delta: ParseDelta) => Promise<void>;
  /** Runs in the transaction that marks a session done, under its row lock. */
  onSessionComplete?: (tx: postgres.Sql, sessionId: string) => Promise<void>;
}

export interface ChunkBackfillResult {
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
async function backfillOneStep(sql: postgres.Sql, spec: ChunkBackfillSpec, sessionId: string): Promise<StepResult> {
  const c = spec.columns;
  return sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as postgres.Sql;

    // First touch of this session's row in this transaction — the lock
    // ordering here is load-bearing (see the module doc comment).
    const [session] = await tx<{ next_seq: number; checkpoint: ParseCheckpoint | null }[]>`
      SELECT ${tx(c.nextChunkSeq)} AS next_seq, ${tx(c.checkpoint)} AS checkpoint
      FROM sessions.sessions
      WHERE id = ${sessionId}::uuid
      FOR UPDATE
    `;
    if (!session) return { completed: false, chunkProcessed: false, bytesConsumed: 0 };

    const nextSeq = session.next_seq;
    const [chunk] = await tx<{ content: string }[]>`
      SELECT content FROM sessions.transcript_chunks
      WHERE session_id = ${sessionId}::uuid AND seq = ${nextSeq}
    `;

    if (!chunk) {
      // No chunk waiting beyond our cursor, under this row's lock — caught
      // up. A live-ingest cycle concurrently appending a new chunk is
      // blocked on this same lock until this transaction commits, and will
      // then see the flag true and take over writing its own new content.
      await tx`UPDATE sessions.sessions SET ${tx(c.done)} = true WHERE id = ${sessionId}::uuid`;
      if (spec.onSessionComplete) await spec.onSessionComplete(tx, sessionId);
      return { completed: true, chunkProcessed: false, bytesConsumed: 0 };
    }

    const checkpoint = session.checkpoint ?? EMPTY_CHECKPOINT;
    const lines = splitLinesWithTerminators(chunk.content);
    const { checkpoint: nextCheckpoint, delta } = feed(checkpoint, lines);

    await spec.write(tx, sessionId, delta);

    await tx`
      UPDATE sessions.sessions SET
        ${tx(c.nextChunkSeq)} = ${nextSeq + 1},
        ${tx(c.checkpoint)} = ${tx.json(nextCheckpoint as any)}
      WHERE id = ${sessionId}::uuid
    `;

    return { completed: false, chunkProcessed: true, bytesConsumed: Buffer.byteLength(chunk.content, 'utf8') };
  });
}

/**
 * Run one backfill cycle: process chunks — one at a time, across however
 * many sessions it takes — until the byte budget is spent or every session
 * is caught up. Assumes single-flight execution per derivation (the
 * scheduler's advisory lock — specs/behaviors/scheduled-work-leases.md); all
 * progress is durable per session between calls.
 */
export async function runChunkBackfillCycle(
  sql: postgres.Sql,
  spec: ChunkBackfillSpec,
  budgetBytes: number
): Promise<ChunkBackfillResult> {
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
      WHERE ${sql(spec.columns.done)} = false
      ORDER BY id
      LIMIT 1
    `;
    if (!session) break; // every session is caught up
    if (session.id === stalledSessionId) break;

    const result = await backfillOneStep(sql, spec, session.id);
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
