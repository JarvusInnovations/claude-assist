/**
 * Approvals module — the generic human-approval escalation path.
 *
 * Provides:
 * - `fastify.approvals` — request / get / list / resolve / findResolved.
 * - HTTP routes under /api/approvals.
 * - an expiry sweep that ages out unanswered requests.
 *
 * See `specs/modules/approvals.md`. The rule that shapes the module: nothing
 * ever blocks waiting for a human. `request()` records, notifies, and returns.
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import {
  createPlugin,
  type ApprovalsPluginConfig,
  type PluginOptions,
  type Scheduler,
} from '@jarvus/claude-assist-core';
import { ApprovalStore } from './store.js';
import { createApprovalService, DEFAULT_EXPIRY_MS } from './service.js';
import { registerApprovalRoutes } from './routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
  }
}

export default createPlugin('approvals', async (fastify: FastifyInstance, options: PluginOptions) => {
  const config: ApprovalsPluginConfig = options.approvalsConfig ?? {};

  const store = new ApprovalStore(fastify.sql);
  const service = createApprovalService({
    store,
    log: fastify.log,
    ...(fastify.notify ? { notify: fastify.notify } : {}),
    defaultExpiryMs: config.defaultExpiryMs ?? DEFAULT_EXPIRY_MS,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  });

  fastify.decorate('approvals', service);
  await fastify.register(registerApprovalRoutes, { service });

  // Expiry is what keeps a pending gate from hanging forever. A reference
  // implementation this design was compared against declared an `expired`
  // state and never set it anywhere; the sweep is the fix, not an extra.
  fastify.scheduler.register({
    name: 'approvals:expire',
    schedule: config.expireCron ?? '*/15 * * * *',
    runOnStartup: true,
    handler: async () => {
      const expired = await store.expireOverdue();
      if (expired.length > 0) {
        fastify.log.warn(
          { count: expired.length, kinds: [...new Set(expired.map((r) => r.kind))] },
          `Expired ${expired.length} unanswered approval request(s)`,
        );
      }
    },
  });
});

export { ApprovalStore } from './store.js';
export { createApprovalService, DEFAULT_EXPIRY_MS } from './service.js';
export { registerApprovalRoutes } from './routes.js';
