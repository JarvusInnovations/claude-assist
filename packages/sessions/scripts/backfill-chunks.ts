#!/usr/bin/env bun
/**
 * One-shot operator entry point for the legacy-transcript chunk backfill
 * (plans/transcript-chunk-backfill.md; specs/behaviors/
 * session-transcript-storage.md). Runs a bounded number of backfill cycles
 * against DATABASE_URL and exits — for an operator who wants to drive the
 * conversion by hand (watching progress between runs) rather than turning on
 * the scheduled sweep (SESSIONS_BACKFILL_ENABLED).
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun packages/sessions/scripts/backfill-chunks.ts --runs 20
 *
 * Flags:
 *   --runs N                  Number of runs (default 1). Stops early once a
 *                              run considers zero sessions (nothing left to do).
 *   --run-budget-bytes N       Override SESSIONS_BACKFILL_RUN_BUDGET_BYTES's
 *                              default (256 MiB) for this invocation.
 *   --session-budget-bytes N   Override the per-session per-cycle cap (default
 *                              64 MiB, aligned with SESSIONS_INGEST_BUDGET_BYTES).
 *
 * Every run is logged with its outcome counts; the script's final line prints
 * the cumulative totals across all runs it performed.
 */

import postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import { ChunkBackfillService, type BackfillRunResult } from '../src/chunk-backfill.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const args = process.argv.slice(2);
const runs = parseInt(flagValue(args, '--runs') ?? '1', 10);
const runBudgetBytes = flagValue(args, '--run-budget-bytes');
const sessionBudgetBytes = flagValue(args, '--session-budget-bytes');

// A console-backed stand-in for FastifyBaseLogger — this script runs outside
// the server process, so there's no fastify.log to borrow.
const log = {
  info: (obj: unknown, msg?: string) => console.log(msg ?? '', obj ?? ''),
  warn: (obj: unknown, msg?: string) => console.warn(msg ?? '', obj ?? ''),
  error: (obj: unknown, msg?: string) => console.error(msg ?? '', obj ?? ''),
  debug: () => {},
  trace: () => {},
  fatal: (obj: unknown, msg?: string) => console.error(msg ?? '', obj ?? ''),
  child: () => log,
} as unknown as FastifyBaseLogger;

const sql = postgres(DATABASE_URL);
const service = new ChunkBackfillService(sql, log, {
  runBudgetBytes: runBudgetBytes ? parseInt(runBudgetBytes, 10) : undefined,
  sessionBudgetBytes: sessionBudgetBytes ? parseInt(sessionBudgetBytes, 10) : undefined,
});

function summarize(results: BackfillRunResult[]): void {
  const totals = results.reduce(
    (acc, r) => ({
      sessionsConsidered: acc.sessionsConsidered + r.sessionsConsidered,
      sessionsFlipped: acc.sessionsFlipped + r.sessionsFlipped,
      sessionsProgressed: acc.sessionsProgressed + r.sessionsProgressed,
      sessionsFailed: acc.sessionsFailed + r.sessionsFailed,
      sessionsSkipped: acc.sessionsSkipped + r.sessionsSkipped,
      bytesProcessed: acc.bytesProcessed + r.bytesProcessed,
    }),
    {
      sessionsConsidered: 0,
      sessionsFlipped: 0,
      sessionsProgressed: 0,
      sessionsFailed: 0,
      sessionsSkipped: 0,
      bytesProcessed: 0,
    }
  );
  console.log(
    `\nDone after ${results.length} run(s): ${totals.sessionsFlipped} converted, ` +
      `${totals.sessionsProgressed} progressed (multi-run), ${totals.sessionsFailed} failed, ` +
      `${totals.sessionsSkipped} skipped, ${totals.bytesProcessed} bytes read.`
  );
  if (totals.sessionsFailed > 0) {
    console.log('Check `GET /sessions/backfill/status` or `sessions.backfill_failures` for details.');
  }
}

async function main() {
  console.log(`Chunk backfill: running up to ${runs} run(s)...`);
  const results: BackfillRunResult[] = [];
  for (let i = 0; i < runs; i++) {
    const result = await service.runOnce();
    results.push(result);
    console.log(
      `Run ${i + 1}/${runs}: considered=${result.sessionsConsidered} flipped=${result.sessionsFlipped} ` +
        `progressed=${result.sessionsProgressed} failed=${result.sessionsFailed} skipped=${result.sessionsSkipped} ` +
        `bytes=${result.bytesProcessed}`
    );
    if (result.sessionsConsidered === 0) {
      console.log('Nothing left to do — stopping early.');
      break;
    }
  }
  summarize(results);
  await sql.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
