/**
 * Invoker module — the single choke point for metered model calls.
 *
 * Decorates `fastify.invoker`, records every invocation to a spend ledger,
 * enforces rolling-window budgets, and exposes `/api/invoker/spend`.
 *
 * See `specs/modules/invoker.md`. The boundary it defends: metered calls come
 * through here; a human-driven interactive session runs on that human's own
 * credentials and must never reach this module.
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import {
  createPlugin,
  type InvokerPluginConfig,
  type PluginOptions,
  type Scheduler,
} from '@jarvus/claude-assist-core';
import { SpendStore } from './store.js';
import { createBudgetTracker } from './budget.js';
import { createInvoker } from './invoker.js';
import { createAnthropicClient } from './provider.js';
import { resolvePrices, resolveTierModels } from './models.js';
import { registerInvokerRoutes } from './routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
  }
}

export default createPlugin('invoker', async (fastify: FastifyInstance, options: PluginOptions) => {
  const config: InvokerPluginConfig = options.invokerConfig ?? {};

  const store = new SpendStore(fastify.sql);
  const limits = {
    ...(config.dailyBudgetUsd !== undefined ? { dailyUsd: config.dailyBudgetUsd } : {}),
    ...(config.dailyBudgetTokens !== undefined ? { dailyTokens: config.dailyBudgetTokens } : {}),
    ...(config.taskBudgetsUsd ? { taskUsd: config.taskBudgetsUsd } : {}),
  };
  const budget = createBudgetTracker({ store, limits });

  // Seed the in-memory window from the ledger so a restart doesn't reset the
  // day's spend to zero. A failure here degrades to an under-count, which is
  // corrected on the first periodic refresh.
  try {
    await budget.refresh();
  } catch (err) {
    fastify.log.error({ err }, 'Invoker: could not seed spend window from the ledger');
  }

  const invoker = createInvoker({
    log: fastify.log,
    store,
    budget,
    limits,
    tierModels: resolveTierModels(config.tierModels),
    prices: resolvePrices(config.prices),
    ...(config.anthropicApiKey ? { client: createAnthropicClient(config.anthropicApiKey) } : {}),
    ...(fastify.approvals ? { approvals: fastify.approvals } : {}),
    ...(config.killSwitch !== undefined ? { killSwitch: config.killSwitch } : {}),
    ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}),
    ...(config.retryBaseMs !== undefined ? { retryBaseMs: config.retryBaseMs } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  });

  fastify.decorate('invoker', invoker);
  await fastify.register(registerInvokerRoutes, { invoker });

  if (!config.anthropicApiKey) {
    fastify.log.warn('Invoker: no ANTHROPIC_API_KEY — every model-backed feature is disabled');
  } else if (config.killSwitch) {
    fastify.log.warn('Invoker: MODEL_KILL_SWITCH is on — all metered invocation is stopped');
  }
});

export { createInvoker, extractTag, type InvokerDeps } from './invoker.js';
export { createBudgetTracker, windowStart, type BudgetLimits, type BudgetTracker } from './budget.js';
export { SpendStore, type SpendStorePort, type InvocationRow } from './store.js';
export {
  createAnthropicClient,
  normalizeMediaType,
  type MessagesClient,
  type ProviderRequest,
  type ProviderResponse,
} from './provider.js';
export {
  DEFAULT_TIER_MODELS,
  DEFAULT_PRICES,
  DEFAULT_TIER_TIMEOUTS_MS,
  MIN_CACHEABLE_SYSTEM_CHARS,
  estimateCostMicros,
  resolvePrices,
  resolveTierModels,
  type ModelPrice,
} from './models.js';
export { registerInvokerRoutes } from './routes.js';
