/**
 * Ledger module — the derived audit ledger + direct-write surface.
 *
 * Provides:
 * - `fastify.ledger`  — the direct-write decorator (`record(...)`) that
 *   transcript-less services (email executor, notification dispatcher, future
 *   automation) call at execution time.
 * - a scheduled incremental derivation pass that classifies external actions
 *   out of `sessions.tool_calls` via the versioned ruleset.
 * - a boot-time RULES_VERSION check that re-derives the whole corpus on a bump.
 * - internal HTTP routes (GET /ledger/actions, GET /ledger/summary).
 *
 * See specs/audit-ledger.md: derived and direct rows share one schema and one
 * query surface; derivation is replayable, so improving the rules retroactively
 * improves the whole history.
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import {
  createPlugin,
  type PluginOptions,
  type Scheduler,
  type LedgerPluginConfig,
} from '@jarvus/claude-assist-core';
import { LedgerStore } from './store.js';
import { RULES, RULES_VERSION } from './rules.js';
import {
  ensureRulesVersion,
  runIncrementalDerivation,
} from './derivation.js';
import { registerLedgerRoutes } from './routes.js';

// Module augmentation for fastify decorators
declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
  }
}

export default createPlugin('ledger', async (fastify: FastifyInstance, options: PluginOptions) => {
  const config: LedgerPluginConfig = options.ledgerConfig ?? {};
  const batchSize = config.batchSize ?? 1000;

  const store = new LedgerStore(fastify.sql);

  // Direct-write surface — record() is guarded by callers with `fastify.ledger?.`.
  fastify.decorate('ledger', {
    record: (input) => store.recordDirect(input),
  });

  await fastify.register(registerLedgerRoutes, { store });

  // Boot: detect a ruleset-version change and re-derive loudly. On a truly fresh
  // database this is a no-op (the cursor is just initialized); on a version bump
  // over an existing corpus it replays every tool call. Wrapped so a not-yet-
  // migrated sessions schema on first boot degrades to a logged warning rather
  // than failing startup.
  try {
    await ensureRulesVersion(store, {
      rules: RULES,
      rulesVersion: RULES_VERSION,
      batchSize,
      log: fastify.log,
    });
  } catch (err) {
    fastify.log.error(
      { err },
      'Ledger: boot rules-version check failed (sessions schema not ready?) — derivation will retry on schedule',
    );
  }

  // Scheduled incremental derivation. Extraction lag equals ingestion lag, so a
  // modest cadence is fine; the backfill of an initialized ledger happens here.
  if (!config.disableDerivation) {
    fastify.scheduler.register({
      name: 'ledger:derive',
      schedule: config.deriveCron ?? '*/15 * * * *',
      runOnStartup: false,
      handler: async () => {
        const result = await runIncrementalDerivation(store, {
          rules: RULES,
          rulesVersion: RULES_VERSION,
          batchSize,
          log: fastify.log,
        });
        if (result.inserted > 0 || result.scanned > 0) {
          fastify.log.info(result, 'Ledger derivation cycle complete');
        }
      },
    });
  } else {
    fastify.log.info('Ledger: scheduled derivation disabled via config');
  }

  fastify.log.info({ rulesVersion: RULES_VERSION }, 'Ledger module loaded');
});

// Re-export the implementation surface for tests / external use.
export {
  RULES,
  RULES_VERSION,
  classifyToolCall,
  deriveAction,
  type LedgerRule,
  type ToolCallRow,
  type DerivedActionRecord,
  type Classification,
} from './rules.js';
export {
  LedgerStore,
  type DerivationStore,
  type ActionQuery,
  type ActionRow,
  type SummaryRow,
} from './store.js';
export {
  runIncrementalDerivation,
  reDerive,
  ensureRulesVersion,
  type DerivationOptions,
  type DerivationResult,
  type ReDeriveResult,
  type VersionOutcome,
} from './derivation.js';
export { registerLedgerRoutes, type LedgerRoutesConfig } from './routes.js';
