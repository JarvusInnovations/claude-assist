/**
 * The derivation job.
 *
 * Incremental derivation replays the ruleset over tool calls the ledger has not
 * yet seen (by ascending `sessions.tool_calls.id`), advancing a singleton
 * cursor. It is idempotent: the unique `(tool_call_id, rules_version)` index +
 * `ON CONFLICT DO NOTHING` mean re-running never duplicates, and the cursor
 * means a completed range is never re-scanned.
 *
 * Re-derivation (on a `RULES_VERSION` bump) deletes every derived row, resets
 * the cursor, and replays the whole corpus. Direct rows are never touched.
 *
 * Extraction lag equals ingestion lag — audit queries are not latency
 * sensitive — so this runs on a modest schedule rather than at emit time.
 */

import type { FastifyBaseLogger } from 'fastify';
import { deriveAction, type LedgerRule, type DerivedActionRecord } from './rules.js';
import type { DerivationStore } from './store.js';

export interface DerivationOptions {
  rules: LedgerRule[];
  rulesVersion: string;
  /** Tool calls fetched + processed per batch (default 1000). */
  batchSize?: number;
  log?: FastifyBaseLogger;
}

export interface DerivationResult {
  scanned: number;
  inserted: number;
}

/**
 * Derive over all tool calls after the current cursor, advancing it as it goes.
 * Safe to call repeatedly; a fully-caught-up ledger does no work.
 */
export async function runIncrementalDerivation(
  store: DerivationStore,
  opts: DerivationOptions,
): Promise<DerivationResult> {
  const batchSize = opts.batchSize ?? 1000;
  const state = await store.getState();
  let cursor = state?.lastToolCallId ?? 0;

  let scanned = 0;
  let inserted = 0;

  for (;;) {
    const batch = await store.fetchToolCallsAfter(cursor, batchSize);
    if (batch.length === 0) break;

    const records: DerivedActionRecord[] = [];
    for (const tc of batch) {
      const record = deriveAction(tc, opts.rules, opts.rulesVersion);
      if (record) records.push(record);
    }

    inserted += await store.insertDerived(records);
    scanned += batch.length;

    const last = batch[batch.length - 1]!;
    cursor = Number(last.id);
    await store.setState(opts.rulesVersion, cursor);

    // A short batch means we drained the table.
    if (batch.length < batchSize) break;
  }

  return { scanned, inserted };
}

export interface ReDeriveResult extends DerivationResult {
  deleted: number;
}

/**
 * Full re-derivation: drop all derived rows, reset the cursor, replay the
 * corpus under the current ruleset version. Direct rows are untouched.
 */
export async function reDerive(
  store: DerivationStore,
  opts: DerivationOptions,
): Promise<ReDeriveResult> {
  const deleted = await store.deleteDerived();
  await store.setState(opts.rulesVersion, 0);
  const { scanned, inserted } = await runIncrementalDerivation(store, opts);
  return { deleted, scanned, inserted };
}

export type VersionOutcome = 'fresh' | 'current' | 'rederived';

/**
 * Boot-time check: compare the code's ruleset version against the version
 * recorded in the cursor. On a mismatch, log loudly and re-derive the whole
 * corpus so a rule change takes effect retroactively.
 *
 * - `fresh`     — no prior state; the cursor is initialized and the scheduled
 *   pass will backfill.
 * - `current`   — versions match; nothing to do.
 * - `rederived` — versions differed; a full re-derivation ran.
 */
export async function ensureRulesVersion(
  store: DerivationStore,
  opts: DerivationOptions,
): Promise<VersionOutcome> {
  const state = await store.getState();

  if (!state) {
    await store.setState(opts.rulesVersion, 0);
    opts.log?.info(
      { rulesVersion: opts.rulesVersion },
      'Ledger: initialized derivation cursor (backfill runs on the next derivation cycle)',
    );
    return 'fresh';
  }

  if (state.rulesVersion !== opts.rulesVersion) {
    opts.log?.warn(
      { from: state.rulesVersion, to: opts.rulesVersion },
      'Ledger: RULES_VERSION changed — re-deriving the entire corpus (derived rows replaced; direct rows preserved)',
    );
    const result = await reDerive(store, opts);
    opts.log?.warn({ ...result, rulesVersion: opts.rulesVersion }, 'Ledger: re-derivation complete');
    return 'rederived';
  }

  return 'current';
}
