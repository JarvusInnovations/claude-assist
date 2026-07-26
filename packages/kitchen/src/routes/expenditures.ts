/**
 * Expenditure & net-energy routes (specs/modules/kitchen.md § Expenditure &
 * net energy, claude-assist#121) — registered under /api/kitchen.
 *
 *   POST   /kitchen/expenditures        - record a stated burn (idempotent on ulid)
 *   GET    /kitchen/expenditures        - list, newest first
 *   DELETE /kitchen/expenditures/:ulid  - remove from all rollups
 *   GET    /kitchen/summary             - windowed intake/expenditure/net rollup
 *
 * The net line is computed HERE (server-side) so every surface reads one
 * consistent number: net = (tdee_base + expenditure) − intake. Without a
 * configured tdee_base the net fields are omitted — never guessed. Framing
 * rule (normative in the spec): the net is context, not a spend-it budget —
 * no surface derives remaining-intake headroom from it, and this API gives
 * them nothing to derive it from.
 */

import type { FastifyPluginAsync } from 'fastify';
import { ULID_PATTERN, generateUlid } from '../ulid.js';
import { coerceBareDateToLocalNoon } from '../date-coerce.js';
import type { EntryStore, ExpenditureStore } from '../store.js';
import type { DailyTargets } from '../daily-targets.js';

export interface ExpenditureRoutesConfig {
  store: ExpenditureStore;
  entries: EntryStore;
  /** KITCHEN_TDEE_BASE — opaque instance config; unset ⇒ net omitted. */
  tdeeBase?: number;
  /** KITCHEN_DAILY_TARGETS, parsed — opaque instance config; unset ⇒ targets omitted. */
  dailyTargets?: DailyTargets;
}

const EXPENDITURE_SOURCES = ['strava', 'health_connect', 'garmin', 'manual'] as const;

const POST_BODY_SCHEMA = {
  type: 'object',
  required: ['occurred_at', 'source', 'label', 'kcal'],
  additionalProperties: false,
  properties: {
    ulid: { type: 'string' },
    occurred_at: { type: 'string' },
    source: { type: 'string', enum: [...EXPENDITURE_SOURCES] },
    label: { type: 'string', minLength: 1, maxLength: 200 },
    kcal: { type: 'number', minimum: 0 },
    duration_min: { type: ['number', 'null'], minimum: 0 },
    avg_hr: { type: ['number', 'null'], minimum: 0 },
  },
} as const;

interface ExpenditureBody {
  ulid?: string;
  occurred_at: string;
  source: (typeof EXPENDITURE_SOURCES)[number];
  label: string;
  kcal: number;
  duration_min?: number | null;
  avg_hr?: number | null;
}

function toView(r: {
  ulid: string;
  occurred_at: Date;
  source: string;
  label: string;
  kcal: number;
  duration_min: number | null;
  avg_hr: number | null;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    ulid: r.ulid,
    occurred_at: r.occurred_at.toISOString(),
    source: r.source,
    label: r.label,
    kcal: r.kcal,
    duration_min: r.duration_min,
    avg_hr: r.avg_hr,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

function parseIso(value: string | undefined, name: string): Date | null | 'invalid' {
  if (value === undefined) return null;
  // A bare `YYYY-MM-DD` occurred_at coerces to local noon (specs/modules/
  // kitchen.md § Logged-at backdating); a full timestamp passes through.
  const d = new Date(coerceBareDateToLocalNoon(value));
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
}

export const registerExpenditureRoutes: FastifyPluginAsync<ExpenditureRoutesConfig> = async (
  fastify,
  config
) => {
  const { store, entries, tdeeBase, dailyTargets } = config;

  fastify.post<{ Body: ExpenditureBody }>(
    '/kitchen/expenditures',
    { schema: { body: POST_BODY_SCHEMA } },
    async (request, reply) => {
      const body = request.body;
      if (body.ulid !== undefined && !ULID_PATTERN.test(body.ulid)) {
        reply.status(400);
        return { error: 'ulid must be a valid ULID' };
      }
      const occurredAt = parseIso(body.occurred_at, 'occurred_at');
      if (occurredAt === 'invalid' || occurredAt === null) {
        reply.status(400);
        return { error: 'occurred_at must be an ISO date-time' };
      }
      const { record, created } = await store.insertIfAbsent({
        ulid: body.ulid ?? generateUlid(),
        occurred_at: occurredAt,
        source: body.source,
        label: body.label.trim(),
        kcal: body.kcal,
        duration_min: body.duration_min ?? null,
        avg_hr: body.avg_hr ?? null,
      });
      reply.status(created ? 201 : 200);
      return toView(record);
    }
  );

  fastify.get<{ Querystring: { since?: string; until?: string; limit?: string } }>(
    '/kitchen/expenditures',
    async (request, reply) => {
      const since = parseIso(request.query.since, 'since');
      const until = parseIso(request.query.until, 'until');
      if (since === 'invalid' || until === 'invalid') {
        reply.status(400);
        return { error: 'since/until must be ISO date-times' };
      }
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      const rows = await store.list({ since: since ?? undefined, until: until ?? undefined, limit });
      return { expenditures: rows.map(toView), count: rows.length };
    }
  );

  fastify.delete<{ Params: { ulid: string } }>(
    '/kitchen/expenditures/:ulid',
    async (request, reply) => {
      const deleted = await store.delete(request.params.ulid);
      if (!deleted) {
        reply.status(404);
        return { error: 'Expenditure not found' };
      }
      return { deleted: request.params.ulid };
    }
  );

  // ── Windowed net-energy summary ─────────────────────────────────────────────
  // The caller supplies the window (its own local-day boundaries) — the server
  // makes no timezone assumptions. Intake sums EFFECTIVE calories (base ×
  // portion_multiplier, nulls skipped, § Portion multiplier).
  fastify.get<{ Querystring: { since: string; until: string } }>(
    '/kitchen/summary',
    async (request, reply) => {
      const since = parseIso(request.query.since, 'since');
      const until = parseIso(request.query.until, 'until');
      if (since === 'invalid' || until === 'invalid' || since === null || until === null) {
        reply.status(400);
        return { error: 'summary requires since and until as ISO date-times' };
      }

      const dayEntries = (await entries.list({ since, limit: 500 })).filter(
        (e) => e.logged_at < until
      );
      let intake = 0;
      for (const e of dayEntries) {
        if (typeof e.calories === 'number') intake += e.calories * (e.portion_multiplier ?? 1);
      }
      intake = Math.round(intake * 10) / 10;

      const burns = await store.list({ since, until, limit: 500 });
      const expenditureKcal = Math.round(burns.reduce((sum, b) => sum + b.kcal, 0) * 10) / 10;

      return {
        since: since.toISOString(),
        until: until.toISOString(),
        intake_kcal: intake,
        entry_count: dayEntries.length,
        expenditure_kcal: expenditureKcal,
        expenditure_count: burns.length,
        // Net only when the instance states its base — never guessed.
        ...(typeof tdeeBase === 'number'
          ? {
              tdee_base_kcal: tdeeBase,
              net_kcal: Math.round((tdeeBase + expenditureKcal - intake) * 10) / 10,
            }
          : {}),
        // Owner-set reference lines, verbatim (§ Daily targets). remaining is
        // client-side display arithmetic; the calories target is static and
        // intake-managed — never adjusted by the day's burn (framing rule).
        ...(dailyTargets !== undefined ? { targets: dailyTargets } : {}),
      };
    }
  );
};
