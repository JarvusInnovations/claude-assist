/**
 * Plan-session route (specs/modules/kitchen.md § Plan-session).
 *
 *   POST /kitchen/plan-session — gather the meal-planning context, compose a
 *   warm-start preload prompt, and ask the generic SessionSpawner to warm an
 *   interactive session + ping the phone with a takeover link.
 *
 * Returns an ACK, never the link: the takeover link rides the push alone
 * (redacted at rest), so a screenshot/log of this response can never leak a
 * session handle. The endpoint returns only the spawner record's status +
 * spawn id (the record itself never carries the link).
 */

import type { FastifyPluginAsync } from 'fastify';
import type { KitchenPipeline } from '../services/pipeline.js';
import type { InventoryPipeline } from '../services/inventory.js';
import {
  gatherPlanningContext,
  composePreloadPrompt,
  PLAN_SESSION_TITLE,
  type PlanningContextConfig,
} from '../services/plan-session.js';

export interface PlanSessionRoutesConfig {
  pipeline: KitchenPipeline;
  inventory: InventoryPipeline;
  /** Optional caps for how much context the preload briefing carries. */
  contextConfig?: PlanningContextConfig;
}

const NOT_CONFIGURED = { error: 'session spawning is not configured' } as const;

export const registerPlanSessionRoutes: FastifyPluginAsync<PlanSessionRoutesConfig> = async (
  fastify,
  { pipeline, inventory, contextConfig },
) => {
  fastify.post('/kitchen/plan-session', async (request, reply) => {
    const spawner = fastify.sessionSpawner;
    if (!spawner) {
      reply.status(503);
      return NOT_CONFIGURED;
    }

    const ctx = await gatherPlanningContext({ pipeline, inventory }, contextConfig);
    const preloadPrompt = composePreloadPrompt(ctx);

    const record = await spawner.spawn({ preloadPrompt, title: PLAN_SESSION_TITLE });

    if (record.status === 'not_configured') {
      reply.status(503);
      return NOT_CONFIGURED;
    }
    if (record.status === 'failed') {
      // The spawn command failed (or the link couldn't be delivered). A failure
      // push was dispatched; the response carries only status + id, no reason,
      // no link.
      reply.status(502);
      return { status: 'failed', spawn_id: record.spawnId };
    }

    // Accepted: the takeover link went to the phone (redacted at rest), not here.
    reply.status(200);
    return { status: 'spawned', spawn_id: record.spawnId };
  });
};
