/**
 * Backfill of legacy `storage = 'inline'` transcripts into chunks
 * (specs/behaviors/session-transcript-storage.md; plans/transcript-chunk-backfill.md).
 *
 * Local sync and satellite push both read the bytes they archive from a
 * *file*. This module never does — many of the sessions it targets no longer
 * exist on disk, so the database's own `raw_transcript` column is their only
 * remaining copy. It reuses the same chunking/parsing primitives local sync
 * uses (`chunked-ingest.ts`, `incremental-parser.ts`, `aggregate-merge.ts`,
 * `chunk-store.ts#writeIngestCycleTx`) against byte ranges read out of
 * `raw_transcript` via SQL instead of `fs.read`, and adds a step local sync
 * has no need for: a verify-then-flip transaction, since raw_transcript may
 * be the ONLY copy of some of these transcripts and a silent mismatch here is
 * unrecoverable.
 *
 * ## Byte ranges without a whole-value read
 *
 * `raw_transcript` is `TEXT`. `substring(convert_to(raw_transcript, 'UTF8')
 * FROM … FOR …)` slices it as bytes, returned to the app as a `Buffer`
 * (postgres.js's bytea mapping) bounded by the requested window — never the
 * whole column. `cutAtLastNewline` (reused, not reimplemented, from
 * `chunked-ingest.ts`) then trims that window to the last complete line, the
 * same "never guess at a partial line" rule `readBoundedTail` applies to a
 * file read.
 *
 * ## The concurrency guard
 *
 * Local sync can also touch an `inline` row — if the session's file still
 * exists on disk and has grown, `SyncService#ingestLocalFile` moves it to
 * `catching_up` itself, sourcing bytes from the file. Two writers touching the
 * same session's chunk series is the hazard: **every cycle here runs inside
 * one transaction that takes a `SELECT ... FOR UPDATE` row lock on the session
 * first** (`chunk-store.ts#getChunkStateForUpdate`), then re-reads state
 * *after* acquiring the lock before deciding anything. This is the same row
 * local sync's own `writeIngestCycleTx` UPDATE already locks implicitly, so
 * Postgres serializes the two without either side knowing about the other's
 * lock discipline — whichever transaction commits first, the other (already
 * blocked waiting for the row) wakes up and re-reads the fresh, committed
 * state rather than acting on stale data. An advisory lock keyed by session id
 * was the other option; the row lock was chosen because it needs no new lock
 * namespace and falls out of a resource both writers already touch.
 *
 * A `backfill_owned` column (migration 016) disambiguates which of the two
 * `catching_up` producers a given row belongs to: this task only ever
 * *starts* from `inline`, and only ever *resumes* a `catching_up` row it
 * marked itself. A `catching_up` row local sync produced is left alone.
 */

import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import {
  cutAtLastNewline,
  chunkLines,
  splitLinesWithTerminators,
  DEFAULT_CHUNK_MAX_BYTES,
  DEFAULT_INGEST_BUDGET_BYTES,
} from './chunked-ingest.js';
import { feed, finalize, EMPTY_CHECKPOINT } from './incremental-parser.js';
import { mergeParseDelta, EMPTY_AGGREGATE } from './aggregate-merge.js';
import { getChunkStateForUpdate, writeIngestCycleTx } from './chunk-store.js';

type Tx = postgres.Sql;

/** Total bytes processed across all sessions in one run (one scheduled tick,
 * or one iteration of the one-shot script). Default 256 MiB. */
export const DEFAULT_BACKFILL_RUN_BUDGET_BYTES = 256 * 1024 * 1024;

/** Bytes read from a single session in a single cycle — aligned with (and
 * defaulted to) `SESSIONS_INGEST_BUDGET_BYTES`, so a giant session catches up
 * over the same number of steps local sync would take, and never crowds out
 * every other candidate in one run. */
export const DEFAULT_BACKFILL_SESSION_BUDGET_BYTES = DEFAULT_INGEST_BUDGET_BYTES;

/** How many rows the candidate query considers per run before the byte budget
 * (not the row count) decides how many actually get processed. */
const DEFAULT_CANDIDATE_POOL_SIZE = 500;

export interface ChunkBackfillConfig {
  runBudgetBytes?: number;
  sessionBudgetBytes?: number;
  chunkMaxBytes?: number;
  candidatePoolSize?: number;
}

export type BackfillOutcome = 'progressed' | 'flipped' | 'failed' | 'skipped' | 'missing';

export interface BackfillCycleResult {
  sessionId: string;
  outcome: BackfillOutcome;
  bytesRead: number;
  error?: string;
}

export interface BackfillRunResult {
  sessionsConsidered: number;
  sessionsProgressed: number;
  sessionsFlipped: number;
  sessionsFailed: number;
  sessionsSkipped: number;
  bytesProcessed: number;
  details: BackfillCycleResult[];
}

export interface BackfillStatus {
  /** `storage = 'inline'` rows not yet started, plus rows this task has
   * started but not finished (`catching_up`, `backfill_owned`). */
  remaining: number;
  /** Sum of `octet_length(raw_transcript)` for those same rows — the honest
   * "how much is left" figure, since a `catching_up` row's raw_transcript is
   * still the size of the WHOLE session, not just what's left to chunk. */
  remainingBytes: number;
  /** Sessions this task has flipped to `chunked` (`backfill_owned = TRUE`). */
  converted: number;
  /** Rows parked in `sessions.backfill_failures` — verification failed at
   * least once and the row was reverted to `inline` rather than retried. */
  failed: number;
}

/** Pure sizing helper: how many bytes to request this cycle. Exported for a
 * unit test; trivial but easy to get an off-by-one wrong in (`<=` vs `<`,
 * negative `remaining` once `fromByte` reaches `totalBytes`). */
export function computeReadWindow(fromByte: number, totalBytes: number, capBytes: number): number {
  return Math.max(0, Math.min(capBytes, totalBytes - fromByte));
}

/**
 * Read `[fromByte, fromByte + maxBytes)` of a session's `raw_transcript` as
 * bytes, cut to the last complete line — the DB-sourced analogue of
 * `chunked-ingest.ts#readBoundedTail`. Must run inside the caller's
 * transaction (`tx`) so it sees the row this cycle already holds `FOR UPDATE`,
 * and so the read window byte count (never the whole column) is the only
 * thing that lands in the app.
 */
async function readRawTranscriptWindow(
  tx: Tx,
  sessionId: string,
  fromByte: number,
  maxBytes: number
): Promise<{ content: string; consumedBytes: number }> {
  if (maxBytes <= 0) return { content: '', consumedBytes: 0 };
  const [row] = await tx<{ window_bytes: Buffer | null }[]>`
    SELECT substring(convert_to(raw_transcript, 'UTF8') FROM ${fromByte + 1}::int FOR ${maxBytes}::int) AS window_bytes
    FROM sessions.sessions
    WHERE id = ${sessionId}::uuid
  `;
  const buf = row?.window_bytes ?? Buffer.alloc(0);
  return cutAtLastNewline(buf);
}

interface VerifyRow {
  raw_len: number | null;
  raw_md5: string | null;
  chunk_len: string | number | null;
  chunk_md5: string | null;
}

/**
 * Compare the reassembled chunk series against `raw_transcript` entirely in
 * SQL — both the length and the hash — so a match/mismatch decision never
 * requires either value in the app. `string_agg`/`SUM` run server-side over
 * `sessions.transcript_chunks`; the query returns four small scalars.
 */
async function verifyAgainstRawTranscript(tx: Tx, sessionId: string): Promise<{ ok: boolean; detail: string }> {
  const [row] = await tx<VerifyRow[]>`
    SELECT
      octet_length(s.raw_transcript) AS raw_len,
      md5(s.raw_transcript) AS raw_md5,
      (SELECT COALESCE(SUM(octet_length(content)), 0) FROM sessions.transcript_chunks WHERE session_id = s.id) AS chunk_len,
      (SELECT md5(COALESCE(string_agg(content, '' ORDER BY seq), '')) FROM sessions.transcript_chunks WHERE session_id = s.id) AS chunk_md5
    FROM sessions.sessions s
    WHERE s.id = ${sessionId}::uuid
  `;
  if (!row) return { ok: false, detail: 'session vanished mid-backfill' };
  const chunkLen = row.chunk_len === null ? -1 : Number(row.chunk_len);
  const ok = row.raw_len !== null && chunkLen === row.raw_len && row.chunk_md5 !== null && row.chunk_md5 === row.raw_md5;
  return {
    ok,
    detail: `raw_len=${row.raw_len ?? 'null'} chunk_len=${row.chunk_len ?? 'null'} raw_md5=${row.raw_md5 ?? 'null'} chunk_md5=${row.chunk_md5 ?? 'null'}`,
  };
}

/** Revert a failed session to plain `inline`, deleting whatever partial chunk
 * series this task built for it and recording the failure so the candidate
 * query stops offering it. Runs inside the same transaction as the failed
 * verification — the row never spends a moment claiming both `chunked` and
 * an intact `raw_transcript` are true, nor a moment with neither. */
async function revertAndRecordFailure(tx: Tx, sessionId: string, reason: string): Promise<void> {
  await tx`DELETE FROM sessions.transcript_chunks WHERE session_id = ${sessionId}::uuid`;
  await tx`DELETE FROM sessions.transcript_messages WHERE session_id = ${sessionId}::uuid`;
  await tx`DELETE FROM sessions.tool_calls WHERE session_id = ${sessionId}::uuid`;
  await tx`
    UPDATE sessions.sessions
    SET storage = 'inline', ingested_bytes = 0, parse_checkpoint = NULL,
        catchup_threshold_bytes = NULL, backfill_owned = FALSE
    WHERE id = ${sessionId}::uuid
  `;
  await tx`
    INSERT INTO sessions.backfill_failures (session_id, attempts, last_error)
    VALUES (${sessionId}::uuid, 1, ${reason})
    ON CONFLICT (session_id) DO UPDATE SET
      attempts = sessions.backfill_failures.attempts + 1,
      last_error = EXCLUDED.last_error,
      failed_at = NOW()
  `;
}

/**
 * One session, one cycle: lock, decide, read a bounded window, parse
 * incrementally, write. On the cycle that reaches full coverage, verify then
 * flip (or verify-fail then revert) before committing.
 */
async function processSessionCycle(
  sql: postgres.Sql,
  log: FastifyBaseLogger,
  sessionId: string,
  sessionBudgetBytes: number,
  chunkMaxBytes: number
): Promise<BackfillCycleResult> {
  return sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as Tx;
    const state = await getChunkStateForUpdate(tx, sessionId);
    if (!state) return { sessionId, outcome: 'missing', bytesRead: 0 };

    // Re-checked under the lock, not from whatever the (unlocked) candidate
    // query saw — the only state this decision may act on.
    const fresh = state.storage === 'inline';
    const continuing = state.storage === 'catching_up' && state.backfillOwned;
    if (!fresh && !continuing) {
      return { sessionId, outcome: 'skipped', bytesRead: 0 };
    }

    const rawLen = state.rawTranscriptLength ?? 0;
    const fromByte = fresh ? 0 : state.ingestedBytes;
    const toRead = computeReadWindow(fromByte, rawLen, sessionBudgetBytes);
    const { content, consumedBytes } = await readRawTranscriptWindow(tx, sessionId, fromByte, toRead);

    const remaining = rawLen - fromByte;
    if (consumedBytes === 0 && remaining > 0) {
      // No complete line fits in this cycle's window — a single line bigger
      // than the session budget. Defer rather than guess at a partial line,
      // mirroring `readBoundedTail`'s contract for a file read.
      return { sessionId, outcome: 'skipped', bytesRead: 0 };
    }

    const startCheckpoint = fresh ? EMPTY_CHECKPOINT : state.parseCheckpoint;
    const priorAggregate = fresh ? EMPTY_AGGREGATE : state.aggregate;
    const nextChunkSeq = fresh ? 0 : (state.lastChunk?.seq ?? -1) + 1;

    const lines = splitLinesWithTerminators(content);
    const { checkpoint: fedCheckpoint, delta, lineSeqs } = feed(startCheckpoint, lines);
    let aggregate = mergeParseDelta(priorAggregate, delta);
    let checkpoint = fedCheckpoint;

    const ingestedBytesNew = fromByte + consumedBytes;
    const reachedEnd = ingestedBytesNew >= rawLen;
    if (reachedEnd) {
      // raw_transcript is frozen (backfill's only source), so reaching its
      // full length IS true end-of-transcript — finalize any chains still
      // open, exactly as local sync does when a session-ended signal fires.
      const { checkpoint: fc, delta: finDelta } = finalize(fedCheckpoint);
      checkpoint = fc;
      aggregate = mergeParseDelta(aggregate, finDelta);
    }

    const chunks = chunkLines(lines, lineSeqs, fromByte, chunkMaxBytes);

    // Claim ownership before the first write lands, so a crash between here
    // and the eventual flip still leaves the row resumable by this task (and
    // never mistaken for a local-sync-owned catching_up row).
    await tx`UPDATE sessions.sessions SET backfill_owned = TRUE WHERE id = ${sessionId}::uuid`;

    await writeIngestCycleTx(tx, {
      sessionId,
      machineId: state.machineId,
      projectPath: state.aggregate.cwd,
      transcriptPath: state.transcriptPath,
      startedAtFallback: aggregate.endedAt ?? aggregate.startedAt ?? new Date(),
      chunks,
      aggregate,
      toolCalls: delta.toolCalls,
      messageIndexRows: delta.messageIndexRows,
      checkpoint,
      ingestedBytes: ingestedBytesNew,
      storage: 'catching_up',
      catchupThresholdBytes: rawLen,
      clearRawTranscript: false,
      isNew: false,
      fresh,
      nextChunkSeq,
    });

    if (!reachedEnd) {
      return { sessionId, outcome: 'progressed', bytesRead: consumedBytes };
    }

    const { ok, detail } = await verifyAgainstRawTranscript(tx, sessionId);
    if (ok) {
      await tx`
        UPDATE sessions.sessions
        SET storage = 'chunked', raw_transcript = NULL, catchup_threshold_bytes = NULL
        WHERE id = ${sessionId}::uuid
      `;
      return { sessionId, outcome: 'flipped', bytesRead: consumedBytes };
    }

    const reason = `chunk/raw mismatch at flip: ${detail}`;
    log.error({ sessionId, reason }, 'Chunk backfill verification failed; reverting to inline');
    await revertAndRecordFailure(tx, sessionId, reason);
    return { sessionId, outcome: 'failed', bytesRead: consumedBytes, error: reason };
  });
}

interface Candidate {
  id: string;
  totalBytes: number;
}

/**
 * Smallest-first candidates: fresh `inline` rows, plus `catching_up` rows this
 * task itself already started (`backfill_owned`), ordered by the FULL
 * archived size (not bytes remaining) so small sessions finish — and show up
 * converted — before a handful of giant ones eat a run's budget. Rows in
 * `sessions.backfill_failures` are excluded so a permanent mismatch is never
 * retried every run. Unlocked — this is only ever used to build a work list;
 * every row it names is re-verified under its own lock in
 * `processSessionCycle`.
 */
async function pickCandidates(sql: postgres.Sql, poolSize: number): Promise<Candidate[]> {
  const rows = await sql<{ id: string; total_bytes: number }[]>`
    SELECT s.id, octet_length(s.raw_transcript) AS total_bytes
    FROM sessions.sessions s
    WHERE s.raw_transcript IS NOT NULL
      AND (s.storage = 'inline' OR (s.storage = 'catching_up' AND s.backfill_owned = TRUE))
      AND NOT EXISTS (SELECT 1 FROM sessions.backfill_failures f WHERE f.session_id = s.id)
    ORDER BY octet_length(s.raw_transcript) ASC
    LIMIT ${poolSize}
  `;
  return rows.map((r) => ({ id: r.id, totalBytes: r.total_bytes }));
}

export class ChunkBackfillService {
  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private runBudgetBytes: number;
  private sessionBudgetBytes: number;
  private chunkMaxBytes: number;
  private candidatePoolSize: number;

  constructor(sql: postgres.Sql, log: FastifyBaseLogger, config: ChunkBackfillConfig = {}) {
    this.sql = sql;
    this.log = log;
    this.runBudgetBytes = config.runBudgetBytes ?? DEFAULT_BACKFILL_RUN_BUDGET_BYTES;
    this.sessionBudgetBytes = config.sessionBudgetBytes ?? DEFAULT_BACKFILL_SESSION_BUDGET_BYTES;
    this.chunkMaxBytes = config.chunkMaxBytes ?? DEFAULT_CHUNK_MAX_BYTES;
    this.candidatePoolSize = config.candidatePoolSize ?? DEFAULT_CANDIDATE_POOL_SIZE;
  }

  /**
   * One run: pick candidates smallest-first, process one cycle per session
   * (at most `sessionBudgetBytes` of `raw_transcript` each), until the run's
   * total byte budget is spent or the candidate pool runs out.
   */
  async runOnce(): Promise<BackfillRunResult> {
    const result: BackfillRunResult = {
      sessionsConsidered: 0,
      sessionsProgressed: 0,
      sessionsFlipped: 0,
      sessionsFailed: 0,
      sessionsSkipped: 0,
      bytesProcessed: 0,
      details: [],
    };

    const candidates = await pickCandidates(this.sql, this.candidatePoolSize);

    for (const candidate of candidates) {
      if (result.bytesProcessed >= this.runBudgetBytes) break;

      result.sessionsConsidered++;
      let outcome: BackfillCycleResult;
      try {
        outcome = await processSessionCycle(this.sql, this.log, candidate.id, this.sessionBudgetBytes, this.chunkMaxBytes);
      } catch (error) {
        this.log.error({ error, sessionId: candidate.id }, 'Chunk backfill cycle threw');
        outcome = { sessionId: candidate.id, outcome: 'skipped', bytesRead: 0, error: String(error) };
      }

      result.details.push(outcome);
      result.bytesProcessed += outcome.bytesRead;
      if (outcome.outcome === 'progressed') result.sessionsProgressed++;
      else if (outcome.outcome === 'flipped') result.sessionsFlipped++;
      else if (outcome.outcome === 'failed') result.sessionsFailed++;
      else result.sessionsSkipped++;
    }

    if (result.sessionsFlipped > 0 || result.sessionsFailed > 0) {
      this.log.info({ result: summarizeRun(result) }, 'Chunk backfill run complete');
    }

    return result;
  }

  /** `runs` sequential calls to `runOnce`, stopping early once nothing is left
   * to do — the one-shot script's loop, factored out so it's testable without
   * a process boundary. */
  async runMany(runs: number): Promise<BackfillRunResult[]> {
    const results: BackfillRunResult[] = [];
    for (let i = 0; i < runs; i++) {
      const result = await this.runOnce();
      results.push(result);
      if (result.sessionsConsidered === 0) break;
    }
    return results;
  }

  async status(): Promise<BackfillStatus> {
    const [remainingRow] = await this.sql<{ remaining: string; remaining_bytes: string | null }[]>`
      SELECT COUNT(*) AS remaining, COALESCE(SUM(octet_length(raw_transcript)), 0) AS remaining_bytes
      FROM sessions.sessions
      WHERE raw_transcript IS NOT NULL
        AND (storage = 'inline' OR (storage = 'catching_up' AND backfill_owned = TRUE))
    `;
    const [convertedRow] = await this.sql<{ converted: string }[]>`
      SELECT COUNT(*) AS converted FROM sessions.sessions WHERE storage = 'chunked' AND backfill_owned = TRUE
    `;
    const [failedRow] = await this.sql<{ failed: string }[]>`
      SELECT COUNT(*) AS failed FROM sessions.backfill_failures
    `;
    return {
      remaining: parseInt(remainingRow?.remaining ?? '0', 10),
      remainingBytes: parseInt(remainingRow?.remaining_bytes ?? '0', 10),
      converted: parseInt(convertedRow?.converted ?? '0', 10),
      failed: parseInt(failedRow?.failed ?? '0', 10),
    };
  }
}

function summarizeRun(result: BackfillRunResult): Omit<BackfillRunResult, 'details'> {
  const { details: _details, ...rest } = result;
  return rest;
}
