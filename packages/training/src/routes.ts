/**
 * HTTP surface for the training loop. Same auth posture as the rest of /api.
 *
 *   GET  /api/training/plan              — the active plan covering a date
 *   GET  /api/training/plans             — recent plans, any status
 *   GET  /api/training/plans/:weekStart  — one week
 *   POST /api/training/plan/generate     — regenerate now (still async-gated)
 *
 * `generate` runs the same code path the schedule does, gate and all: it
 * proposes, it does not activate. There is deliberately no endpoint that
 * activates a plan directly — approval lives in the approvals module, and a
 * second door into it would be a way to bypass the gate.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { WeekPlanStore } from './store.js';
import { runWeeklyPlanning, type WeeklyPlanningDeps } from './runner.js';
import { isIsoDate, todayIsoInTz, weekStartOf } from './week.js';

export interface TrainingRoutesConfig {
  store: WeekPlanStore;
  timeZone: string;
  /** Everything `runWeeklyPlanning` needs except the per-request week. */
  planningDeps: () => WeeklyPlanningDeps;
}

export const registerTrainingRoutes: FastifyPluginAsync<TrainingRoutesConfig> = async (
  fastify,
  { store, timeZone, planningDeps }
) => {
  fastify.get<{ Querystring: { date?: string } }>(
    '/training/plan',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
        },
      },
    },
    async (request) => {
      const date = request.query.date ?? todayIsoInTz(timeZone);
      const plan = await store.activeForDate(date);
      const session = plan?.sessions.find((s) => s.date === date) ?? null;
      return { date, plan, session };
    }
  );

  fastify.get<{ Querystring: { limit?: string } }>(
    '/training/plans',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'string', pattern: '^[0-9]+$' } },
        },
      },
    },
    async (request) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 20;
      const plans = await store.list(limit);
      return { plans, count: plans.length };
    }
  );

  fastify.get<{ Params: { weekStart: string } }>(
    '/training/plans/:weekStart',
    async (request, reply) => {
      if (!isIsoDate(request.params.weekStart)) {
        return reply.code(400).send({ error: 'weekStart must be YYYY-MM-DD' });
      }
      const plan = await store.byWeek(weekStartOf(request.params.weekStart));
      if (!plan) return reply.code(404).send({ error: 'No plan for that week' });
      return plan;
    }
  );

  fastify.post<{ Body?: { weekStart?: string } }>(
    '/training/plan/generate',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { weekStart: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
        },
      },
    },
    async (request, reply) => {
      const deps = planningDeps();
      const weekStart = request.body?.weekStart;
      const result = await runWeeklyPlanning({
        ...deps,
        ...(weekStart ? { weekStart: weekStartOf(weekStart) } : {}),
      });
      if (result.outcome === 'skipped_no_planner') {
        return reply.code(503).send({
          error: 'Training planning is unavailable — no metered-model credential is configured',
          ...result,
        });
      }
      return result;
    }
  );
};
