/**
 * Unsubscribe automation routes.
 *
 * Read surfaces plus one manual trigger. There is deliberately NO endpoint that
 * unsubscribes an arbitrary sender on request: the only way into execution is
 * the owner's `unsubscribe_queue` standing (POST /google/senders/standing,
 * written by the digest page's tap), so adding a "just unsubscribe this one"
 * endpoint would open a second source and void the guarantee the whole design
 * rests on.
 *
 * `/google/unsubscribes/review` is the tier-3 weekly review queue.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { AttemptStatus, UnsubscribeService } from '../services/unsubscribe.js';

const STATUSES: AttemptStatus[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'needs_review',
  'skipped',
];

export interface UnsubscribeRoutesConfig {
  unsubscribeService: UnsubscribeService | null;
}

export const registerUnsubscribeRoutes: FastifyPluginAsync<UnsubscribeRoutesConfig> = async (
  fastify,
  { unsubscribeService }
) => {
  const unavailable = { error: 'Unsubscribe automation not available' };

  // GET /google/unsubscribes?status=needs_review — attempt log by status.
  fastify.get<{ Querystring: { status?: string; limit?: string } }>(
    '/google/unsubscribes',
    async (request, reply) => {
      if (!unsubscribeService) return reply.status(503).send(unavailable);
      const status = (request.query.status ?? 'needs_review') as AttemptStatus;
      if (!STATUSES.includes(status)) {
        return reply.status(400).send({ error: `status must be one of: ${STATUSES.join(', ')}` });
      }
      const limit = Math.min(parseInt(request.query.limit ?? '100', 10) || 100, 500);
      const attempts = await unsubscribeService.reviewQueueByStatus(status, limit);
      return { count: attempts.length, status, attempts };
    }
  );

  // GET /google/unsubscribes/review — the tier-3 queue, the weekly-review view.
  fastify.get<{ Querystring: { limit?: string } }>(
    '/google/unsubscribes/review',
    async (request, reply) => {
      if (!unsubscribeService) return reply.status(503).send(unavailable);
      const limit = Math.min(parseInt(request.query.limit ?? '100', 10) || 100, 500);
      const attempts = await unsubscribeService.reviewQueue(limit);
      return { count: attempts.length, attempts };
    }
  );

  // POST /google/unsubscribes/run — run one cycle now. Same code path as the
  // scheduled run, including the whitelist gate and the rate limit; it is a
  // trigger, not a bypass.
  fastify.post('/google/unsubscribes/run', async (_request, reply) => {
    if (!unsubscribeService) return reply.status(503).send(unavailable);
    const result = await unsubscribeService.runCycle();
    return result;
  });
};
