/**
 * HTTP surface for the invoker.
 *
 *   GET /api/invoker/spend   — window totals, per-task breakdown, budget, kill switch
 *   GET /api/invoker/models  — the tier -> model map currently in force
 */

import type { FastifyPluginAsync } from 'fastify';
import type { ModelInvoker } from '@jarvus/claude-assist-core';

export interface InvokerRoutesConfig {
  invoker: ModelInvoker;
}

export const registerInvokerRoutes: FastifyPluginAsync<InvokerRoutesConfig> = async (
  fastify,
  { invoker },
) => {
  fastify.get('/invoker/spend', async () => invoker.spend());

  fastify.get('/invoker/models', async () => {
    const snapshot = await invoker.spend();
    return { enabled: snapshot.enabled, killSwitch: snapshot.killSwitch, models: snapshot.models };
  });
};
