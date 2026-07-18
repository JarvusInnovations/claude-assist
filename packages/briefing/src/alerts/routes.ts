/**
 * Meeting-alert control routes. Registered under the server's /api prefix.
 *
 *   GET    /briefing/overrides            - list per-series overrides
 *   PUT    /briefing/overrides/:seriesId  - upsert (suppress|force [+ lead])
 *   DELETE /briefing/overrides/:seriesId  - clear an override
 *   GET    /briefing/alert-plan?date=…     - resolved plan for a date (eyeball)
 *
 * The override endpoint is the "editable via a small endpoint" correction path;
 * the alert-plan endpoint backs the daily briefing's will-alert-today list and
 * lets the owner (or a review page) preview classification before it bites.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { OverrideAction } from '../types.js';
import type { OverrideStore } from './overrides.js';
import type { PlanProvider } from './plan-provider.js';

export interface BriefingRoutesConfig {
  overrides: OverrideStore;
  planProvider: PlanProvider;
}

const OVERRIDE_BODY_SCHEMA = {
  type: 'object',
  required: ['action'],
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['suppress', 'force'] },
    leadMinutes: { type: ['integer', 'null'], minimum: 0, maximum: 240 },
    note: { type: ['string', 'null'], maxLength: 500 },
  },
} as const;

interface OverrideBody {
  action: OverrideAction;
  leadMinutes?: number | null;
  note?: string | null;
}

export const registerBriefingRoutes: FastifyPluginAsync<BriefingRoutesConfig> = async (
  fastify,
  { overrides, planProvider }
) => {
  fastify.get('/briefing/overrides', async () => {
    return { overrides: await overrides.list() };
  });

  fastify.put<{ Params: { seriesId: string }; Body: OverrideBody }>(
    '/briefing/overrides/:seriesId',
    { schema: { body: OVERRIDE_BODY_SCHEMA } },
    async (request) => {
      const saved = await overrides.upsert({
        seriesId: request.params.seriesId,
        action: request.body.action,
        leadMinutes: request.body.leadMinutes ?? null,
        note: request.body.note ?? null,
      });
      return saved;
    }
  );

  fastify.delete<{ Params: { seriesId: string } }>(
    '/briefing/overrides/:seriesId',
    async (request, reply) => {
      const removed = await overrides.remove(request.params.seriesId);
      if (!removed) reply.status(404);
      return { seriesId: request.params.seriesId, removed };
    }
  );

  fastify.get<{ Querystring: { date?: string } }>('/briefing/alert-plan', async (request) => {
    const plan = await planProvider.planForDate(request.query.date);
    return {
      date: plan.dateIso,
      calendarError: plan.calendarError,
      items: plan.items.map((item) => ({
        eventId: item.event.id,
        seriesId: item.event.seriesId,
        summary: item.event.summary,
        start: item.event.start,
        joinRequired: item.classification.joinRequired,
        reason: item.classification.reason,
        venue: item.classification.venue,
        source: item.classification.source,
        leadMinutes: item.leadMinutes,
        fireAt: item.fireAtMs != null ? new Date(item.fireAtMs).toISOString() : null,
      })),
    };
  });
};
