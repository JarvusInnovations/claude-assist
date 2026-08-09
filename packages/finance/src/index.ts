/**
 * Finance module — a personal-ledger mirror, a monthly review batch, and a
 * transaction-workflow assist.
 *
 * Wiring: a pluggable source (the provider's unofficial API, or an operator's
 * exporter command) → a local mirror → a composed monthly review → a published
 * page + a Tana link → one `notice` ping through the dispatcher → a heartbeat
 * on the coverage ledger with a **monthly** staleness threshold, so a skipped
 * month pages.
 *
 * FIREWALL. This is personal-domain data. The module holds the owner's own
 * credentials and writes to exactly two places: its own schema, and — only from
 * an explicit human-initiated apply — the owner's own ledger at the provider.
 * It has no write path to any shared or team system of record, and must not
 * grow one. Notifications go to the owner's device; the rendered review lives
 * behind the same private surface as every other page this host serves.
 *
 * CADENCE. Monthly batch, and nothing else. There is deliberately no daily
 * sweep, no morning finance section, and no "spending so far today": a daily
 * finance ritual is a chore that gets skipped and then guiltily ignored, which
 * is worse than not having one.
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import {
  TanaMcpClient,
  createPlugin,
  type FinancePluginConfig,
  type HeartbeatRegistry,
  type NotifyDispatcher,
  type PagePublisher,
  type PluginOptions,
  type Scheduler,
} from '@jarvus/claude-assist-core';
import { PgFinanceStore } from './store.js';
import { createFinanceSource } from './source/index.js';
import { TransactionAssist } from './review/assist.js';
import { ReviewTanaWriter } from './review/tana.js';
import { FINANCE_PIPELINE, ReviewRunner } from './review/runner.js';
import { SuggestionApplier } from './apply.js';
import { registerFinanceRoutes } from './routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
    notify?: NotifyDispatcher;
    heartbeats?: HeartbeatRegistry;
    pages?: PagePublisher;
  }
}

/**
 * Default cadence: 09:00 (owner zone) on the 3rd. Not the 1st — a provider's
 * own sync lags the month boundary, and a review composed on the 1st is a
 * review of an incomplete month that then never gets looked at again.
 */
const DEFAULT_REVIEW_CRON = '0 9 3 * *';

/**
 * Default staleness threshold. A month plus slack: a batch that runs a few days
 * late is not news, a month with no review at all is.
 */
const DEFAULT_COVERAGE_THRESHOLD = '40 days';

export default createPlugin('finance', async (fastify: FastifyInstance, options: PluginOptions) => {
  const config: FinancePluginConfig = options.financeConfig ?? {};

  const store = new PgFinanceStore(fastify.sql);
  const source = createFinanceSource(
    config,
    {
      read: () => store.readSession(),
      write: (token) => store.writeSession(token),
      clear: () => store.clearSession(),
    },
    fastify.log,
  );

  const timeZone = config.timeZone ?? 'UTC';
  if (!config.timeZone) {
    fastify.log.warn(
      'Finance: FINANCE_TIMEZONE is not set — monthly period boundaries are computed in UTC',
    );
  }

  const assist =
    !config.disableAssist && fastify.invoker?.enabled
      ? new TransactionAssist(fastify.invoker, fastify.log, {
          ...(config.assistModel ? { model: config.assistModel } : {}),
          ...(config.assistLimit !== undefined ? { limit: config.assistLimit } : {}),
        })
      : null;
  if (!assist) {
    fastify.log.info(
      'Finance: the categorize/annotate assist is off (disabled, or no model invoker) — reviews render without proposals',
    );
  }

  const tana =
    config.tanaMcpUrl && config.tanaMcpToken && config.tanaWorkspaceId
      ? new ReviewTanaWriter(
          new TanaMcpClient({ url: config.tanaMcpUrl, token: config.tanaMcpToken }),
          config.tanaWorkspaceId,
          fastify.log,
        )
      : null;
  if (!tana) {
    fastify.log.info('Finance: Tana is not configured — the review will have no day-node link');
  }

  const coverageThreshold = config.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD;
  const runner = new ReviewRunner({
    store,
    source,
    assist,
    tana,
    pages: fastify.pages,
    notify: fastify.notify,
    heartbeats: fastify.heartbeats,
    log: fastify.log,
    timeZone,
    currency: config.currency ?? 'USD',
    coverageThreshold,
  });

  await fastify.register(registerFinanceRoutes, {
    store,
    source,
    runner,
    applier: new SuggestionApplier(store, source, fastify.log),
  });

  // Register the coverage ledger up front rather than waiting for the first
  // successful beat: an instance that has NEVER produced a review is exactly
  // the one whose silence should be noticed.
  await fastify.heartbeats?.register({
    name: FINANCE_PIPELINE,
    threshold: coverageThreshold,
    metadata: { cadence: 'monthly' },
  });

  if (!config.disableReview) {
    fastify.scheduler.register({
      name: 'finance:monthly-review',
      schedule: config.reviewCron ?? DEFAULT_REVIEW_CRON,
      timezone: timeZone,
      handler: async () => {
        const result = await runner.runScheduled();
        fastify.log.info({ result }, 'Finance monthly review complete');
      },
    });
  } else {
    fastify.log.info('Finance: the monthly review schedule is disabled');
  }

  fastify.log.info(
    { source: source.mode, assist: Boolean(assist), tana: Boolean(tana), timeZone },
    'Finance module loaded',
  );
});

export * from './types.js';
export * from './period.js';
export { PgFinanceStore, type FinanceStore, type NewSuggestion, type ReviewPatch } from './store.js';
export { MemoryFinanceStore } from './memory-store.js';
export {
  composeReview,
  flagTransactions,
  headline,
  type ComposeInput,
} from './review/compose.js';
export {
  TransactionAssist,
  ASSIST_TASK,
  parseSuggestions,
  selectCandidates,
  toSuggestions,
  type AssistConfig,
} from './review/assist.js';
export {
  renderReviewPage,
  reviewSlug,
  reviewTitle,
  escapeHtml,
  type RenderInput,
} from './review/render.js';
export {
  ReviewTanaWriter,
  REVIEW_MARKER,
  extractNodeId,
  renderTanaPaste,
  reviewHeading,
  tanaNodeLink,
} from './review/tana.js';
export {
  ReviewRunner,
  FINANCE_PIPELINE,
  buildReviewNotification,
  type ReviewRunnerDeps,
  type ReviewRunResult,
} from './review/runner.js';
export {
  SuggestionApplier,
  type ApplyOutcome,
  type ApplyResult,
} from './apply.js';
export { registerFinanceRoutes, type FinanceRoutesConfig } from './routes.js';
export * from './source/index.js';
