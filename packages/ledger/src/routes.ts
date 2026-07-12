/**
 * Internal HTTP surface for the ledger. Same auth posture as the other /api
 * routes: no in-app auth (the server sits behind Caddy basic-auth); registered
 * under the /api prefix by the host app.
 *
 *   GET /api/ledger/actions   — unified action log, newest-first, both sources
 *   GET /api/ledger/summary   — counts by action type per day
 */

import type { FastifyPluginAsync } from 'fastify';
import type { LedgerStore } from './store.js';

export interface LedgerRoutesConfig {
  store: LedgerStore;
}

interface ActionsQuery {
  since?: string;
  until?: string;
  type?: string;
  source?: 'derived' | 'direct';
  actor?: string;
  limit?: string;
}

const querySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    since: { type: 'string' },
    until: { type: 'string' },
    type: { type: 'string' },
    source: { type: 'string', enum: ['derived', 'direct'] },
    actor: { type: 'string' },
    limit: { type: 'string', pattern: '^[0-9]+$' },
  },
} as const;

export const registerLedgerRoutes: FastifyPluginAsync<LedgerRoutesConfig> = async (
  fastify,
  { store },
) => {
  fastify.get<{ Querystring: ActionsQuery }>(
    '/ledger/actions',
    { schema: { querystring: querySchema } },
    async (request) => {
      const q = request.query;
      const actions = await store.queryActions({
        since: q.since,
        until: q.until,
        type: q.type,
        source: q.source,
        actor: q.actor,
        limit: q.limit ? parseInt(q.limit, 10) : undefined,
      });
      return { actions, count: actions.length };
    },
  );

  fastify.get<{ Querystring: ActionsQuery }>(
    '/ledger/summary',
    { schema: { querystring: querySchema } },
    async (request) => {
      const q = request.query;
      const summary = await store.summarize({
        since: q.since,
        until: q.until,
        source: q.source,
      });
      return { summary };
    },
  );
};
