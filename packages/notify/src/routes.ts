/**
 * Internal HTTP surface for the notify module. Same auth posture as the other
 * /api routes: no in-app auth — the server sits behind Caddy basic-auth, and
 * these are registered under the /api prefix by the host app.
 *
 *   POST /api/notify                 — dispatch a notification
 *   POST /api/heartbeat/:pipeline    — record a pipeline success (beat)
 *   GET  /api/heartbeats             — enumerate the registry
 */

import type { FastifyPluginAsync } from 'fastify';
import type {
  NotifyDispatcher,
  HeartbeatRegistry,
  NotificationPriority,
  NotificationChannel,
} from '@jarvus/claude-assist-core';

export interface NotifyRoutesConfig {
  dispatcher: NotifyDispatcher;
  heartbeats: HeartbeatRegistry;
}

const VALID_PRIORITIES: NotificationPriority[] = ['interrupt', 'notice', 'digest'];
const VALID_CHANNELS: NotificationChannel[] = ['pushover', 'slack'];

interface NotifyBody {
  priority?: string;
  title?: string;
  body?: string;
  url?: string;
  channel_hints?: string[];
}

interface HeartbeatBody {
  threshold?: string;
  metadata?: Record<string, unknown>;
}

export const registerNotifyRoutes: FastifyPluginAsync<NotifyRoutesConfig> = async (
  fastify,
  { dispatcher, heartbeats }
) => {
  // POST /notify — the delivery spine, exposed for hooks/other services.
  fastify.post<{ Body: NotifyBody }>('/notify', async (request, reply) => {
    const b = request.body ?? {};

    if (!b.priority || !VALID_PRIORITIES.includes(b.priority as NotificationPriority)) {
      reply.status(400);
      return { error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` };
    }
    if (!b.title || !b.body) {
      reply.status(400);
      return { error: 'title and body are required' };
    }

    let channelHints: NotificationChannel[] | undefined;
    if (b.channel_hints !== undefined) {
      if (
        !Array.isArray(b.channel_hints) ||
        !b.channel_hints.every((c) => VALID_CHANNELS.includes(c as NotificationChannel))
      ) {
        reply.status(400);
        return { error: `channel_hints must be an array of: ${VALID_CHANNELS.join(', ')}` };
      }
      channelHints = b.channel_hints as NotificationChannel[];
    }

    const result = await dispatcher.notify({
      priority: b.priority as NotificationPriority,
      title: b.title,
      body: b.body,
      url: b.url,
      channelHints,
    });

    return result;
  });

  // POST /heartbeat/:pipeline — record a successful run.
  fastify.post<{ Params: { pipeline: string }; Body: HeartbeatBody }>(
    '/heartbeat/:pipeline',
    async (request) => {
      const { pipeline } = request.params;
      const b = request.body ?? {};
      await heartbeats.beat(pipeline, {
        threshold: b.threshold,
        metadata: b.metadata,
      });
      return { status: 'ok', pipeline };
    }
  );

  // GET /heartbeats — enumerate the coverage-ledger registry.
  fastify.get('/heartbeats', async () => {
    const rows = await heartbeats.list();
    return { heartbeats: rows };
  });
};
