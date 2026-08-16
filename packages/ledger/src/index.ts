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
import { RULES, RULES_VERSION, compileRules } from './rules.js';
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

  // Instance-specific tooling enters through config, never through the
  // committed ruleset: a public toolkit ships the mechanism, not the roster of
  // one operator's CLIs. Extra rules run AFTER the built-ins, so a configured
  // rule refines the tail rather than shadowing a general one.
  const extraRules = compileRules(config.extraRules ?? [], (spec, error) => {
    fastify.log.error({ err: error, rule: spec.name }, 'Ledger: skipping a malformed extra rule');
  });
  const rules = [...RULES, ...extraRules];
  if (extraRules.length > 0) {
    fastify.log.info({ count: extraRules.length }, 'Ledger: loaded instance extraction rules');
  }

  // Configured rules are outside the committed RULES_VERSION, so adding one
  // classifies new calls but leaves history alone. The suffix is how an
  // operator asks for the corpus to be replayed under the wider ruleset.
  const rulesVersion = config.rulesVersionSuffix
    ? `${RULES_VERSION}+${config.rulesVersionSuffix}`
    : RULES_VERSION;

  // Direct-write surface — record() is guarded by callers with `fastify.ledger?.`.
  fastify.decorate('ledger', {
    record: (input) => store.recordDirect(input),
  });

  await fastify.register(registerLedgerRoutes, { store });

  // Boot: detect a ruleset-version change and re-derive — DETACHED, never
  // awaited inside plugin registration.
  //
  // The comment this replaces claimed the check was "a no-op on a truly fresh
  // database". That is true of a fresh DATABASE and false of the case that
  // actually occurs: a fresh ledger schema over an existing corpus, which is
  // what happens the first time this module is added to a running instance.
  // There it replays every tool call — and fastify's default pluginTimeout is
  // 10s, so on any real corpus the plugin times out, systemd restarts, and the
  // server crash-loops while deriving a partial batch each attempt. Observed
  // live: the whole host down, every module unavailable, while the ledger
  // filled a few hundred rows at a time.
  //
  // Detaching is the fix rather than a larger timeout, because boot latency
  // must not scale with corpus size. The work is already resumable via its
  // cursor and the scheduled job would pick it up regardless; running it here
  // only makes the backfill start sooner.
  void ensureRulesVersion(store, { rules, rulesVersion, batchSize, log: fastify.log })
    .then((outcome) => {
      if (outcome) fastify.log.info({ outcome }, 'Ledger: boot rules-version check complete');
    })
    .catch((err: unknown) => {
      fastify.log.error(
        { err },
        'Ledger: boot rules-version check failed (sessions schema not ready?) — derivation will retry on schedule',
      );
    });

  // Scheduled incremental derivation. Extraction lag equals ingestion lag, so a
  // modest cadence is fine; the backfill of an initialized ledger happens here.
  if (!config.disableDerivation) {
    fastify.scheduler.register({
      name: 'ledger:derive',
      schedule: config.deriveCron ?? '*/15 * * * *',
      runOnStartup: false,
      handler: async () => {
        const result = await runIncrementalDerivation(store, {
          rules,
          rulesVersion,
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

  fastify.log.info({ rulesVersion }, 'Ledger module loaded');
});

// Re-export the implementation surface for tests / external use.
export {
  RULES,
  EXAMPLE_EXTRA_RULES,
  SEGMENT,
  compileRules,
  type LedgerRuleSpec,
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
