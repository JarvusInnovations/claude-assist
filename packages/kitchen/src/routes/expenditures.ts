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
import { installStrictValidation } from '../strict-validation.js';
import { ULID_PATTERN, generateUlid } from '../ulid.js';
import { coerceBareDateToLocalNoon } from '../date-coerce.js';
import type { EntryStore, ExpenditureStore } from '../store.js';
import type { DailyTargets } from '../daily-targets.js';
import { localDay, localDisplay, localToday, resolveOwnerTz, type OwnerTz } from '../zoned.js';
import { NUTRITION_FIELD_KEYS } from '../types.js';
import type { EntryRecord } from '../types.js';
import type { StravaSkippedActivity } from '../services/strava-sync.js';

/**
 * The read seam onto the live Strava sync's skip list (§ Skip visibility).
 * Narrower than `StravaSync` itself — routes never need the sync's write
 * path — and optional: a caller without Strava configured (or tests) simply
 * omits it, and `/kitchen/expenditures/skipped` reports an empty list.
 */
export interface StravaSkipSource {
  getSkipped(): StravaSkippedActivity[];
}

export interface ExpenditureRoutesConfig {
  store: ExpenditureStore;
  entries: EntryStore;
  /** KITCHEN_TDEE_BASE — opaque instance config; unset ⇒ net omitted. */
  tdeeBase?: number;
  /** KITCHEN_DAILY_TARGETS, parsed — opaque instance config; unset ⇒ targets omitted. */
  dailyTargets?: DailyTargets;
  /**
   * Owner timezone (§ Timezone & local-day bucketing) — the one source of truth
   * for the day-grouped rollup's local-day boundaries and each row's `day`.
   * Optional so tests can omit it; absent ⇒ UTC fallback.
   */
  ownerTz?: OwnerTz;
  /** See `StravaSkipSource`. Absent ⇒ Strava isn't configured; skip list is empty. */
  stravaSync?: StravaSkipSource;
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

function toView(
  r: {
    ulid: string;
    occurred_at: Date;
    source: string;
    label: string;
    kcal: number;
    duration_min: number | null;
    avg_hr: number | null;
    created_at: Date;
    updated_at: Date;
  },
  ownerTz: OwnerTz
) {
  return {
    ulid: r.ulid,
    occurred_at: r.occurred_at.toISOString(),
    // Module-owned local-day fields (§ Timezone & local-day bucketing): `day`
    // is the authoritative owner-tz bucketing key; `occurred_local` renders the
    // instant in the owner zone (never a bare `Z`). Raw `occurred_at` stays for ordering.
    day: localDay(r.occurred_at, ownerTz.zone),
    occurred_local: localDisplay(r.occurred_at, ownerTz.zone),
    source: r.source,
    label: r.label,
    kcal: r.kcal,
    duration_min: r.duration_min,
    avg_hr: r.avg_hr,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

/** The nine-field nutrition panel (§ Nutrition panel), for day-grouped totals. */
const PANEL_KEYS = NUTRITION_FIELD_KEYS;

/**
 * One owner-local day's pre-computed rollup (§ Timezone & local-day bucketing —
 * the AXI §4 aggregate that spares an agent hand-summing entries): the
 * effective nine-field panel + calories, and the net line when a TDEE base is
 * configured. Panel sums are null-aware — a field is null only when NO entry
 * that day carried it (absent ≠ zero, § Nutrition panel).
 */
interface DayRollup {
  day: string;
  calories: number | null;
  protein_g: number | null;
  fat_g: number | null;
  sat_fat_g: number | null;
  carbs_g: number | null;
  sugar_g: number | null;
  added_sugar_g: number | null;
  fiber_g: number | null;
  sodium_mg: number | null;
  entry_count: number;
  expenditure_kcal: number;
  expenditure_count: number;
  tdee_base_kcal?: number;
  net_kcal?: number;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Group entries + expenditures into per-owner-local-day rollups. Every day
 * boundary is the owner zone via `ownerTz` — no caller supplies or computes an
 * offset. Effective macros are base × portion_multiplier (§ Portion multiplier),
 * nulls skipped (not zeroed). Ascending by day.
 */
export function rollupByDay(
  entries: EntryRecord[],
  burns: { occurred_at: Date; kcal: number }[],
  ownerTz: OwnerTz,
  tdeeBase?: number
): DayRollup[] {
  interface Acc {
    // running sums; a field stays null until at least one entry contributes it
    sums: Record<string, number | null>;
    entry_count: number;
    expenditure_kcal: number;
    expenditure_count: number;
  }
  const byDay = new Map<string, Acc>();
  const ensure = (day: string): Acc => {
    let acc = byDay.get(day);
    if (!acc) {
      acc = {
        sums: Object.fromEntries(PANEL_KEYS.map((k) => [k, null])),
        entry_count: 0,
        expenditure_kcal: 0,
        expenditure_count: 0,
      };
      byDay.set(day, acc);
    }
    return acc;
  };

  for (const e of entries) {
    const day = localDay(e.logged_at, ownerTz.zone);
    const acc = ensure(day);
    acc.entry_count += 1;
    const mult = typeof e.portion_multiplier === 'number' ? e.portion_multiplier : 1;
    for (const key of PANEL_KEYS) {
      const base = e[key];
      if (typeof base === 'number') acc.sums[key] = (acc.sums[key] ?? 0) + base * mult;
    }

  }
  for (const b of burns) {
    const day = localDay(b.occurred_at, ownerTz.zone);
    const acc = ensure(day);
    acc.expenditure_kcal += b.kcal;
    acc.expenditure_count += 1;
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, acc]) => {
      const panel = Object.fromEntries(
        PANEL_KEYS.map((k) => [k, acc.sums[k] === null ? null : round1(acc.sums[k]!)])
      ) as Pick<DayRollup, (typeof PANEL_KEYS)[number]>;
      const expenditureKcal = round1(acc.expenditure_kcal);
      const intake = typeof panel.calories === 'number' ? panel.calories : 0;
      return {
        day,
        ...panel,
        entry_count: acc.entry_count,
        expenditure_kcal: expenditureKcal,
        expenditure_count: acc.expenditure_count,
        // Net only when the instance states its base — never guessed (same rule
        // as the windowed net line).
        ...(typeof tdeeBase === 'number'
          ? {
              tdee_base_kcal: tdeeBase,
              net_kcal: round1(tdeeBase + expenditureKcal - intake),
            }
          : {}),
      } satisfies DayRollup;
    });
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
  // specs/modules/kitchen.md § Request validation is strict, not permissive
  installStrictValidation(fastify);

  const { store, entries, tdeeBase, dailyTargets, stravaSync } = config;
  const ownerTz = config.ownerTz ?? resolveOwnerTz();

  // Day-grouped summary (`group=day`). The window defaults to the trailing 7
  // owner-local days when unspecified — a caller need not supply, know, or
  // compute any boundary. since/until, when present, are plain instants (bare
  // dates coerce to local noon like every other filter).
  const summaryByDay = async (
    request: { query: { since?: string; until?: string } },
    reply: { status(code: number): void }
  ) => {
    const sinceRaw = parseIso(request.query.since, 'since');
    const untilRaw = parseIso(request.query.until, 'until');
    if (sinceRaw === 'invalid' || untilRaw === 'invalid') {
      reply.status(400);
      return { error: 'since/until must be ISO date-times' };
    }
    const until = untilRaw ?? new Date();
    const since = sinceRaw ?? new Date(until.getTime() - 7 * 86_400_000);

    const dayEntries = (await entries.list({ since, limit: 1000 })).filter((e) => e.logged_at < until);
    const burns = (await store.list({ since, until, limit: 1000 }));
    const days = rollupByDay(dayEntries, burns, ownerTz, tdeeBase);

    return {
      group: 'day',
      tz: ownerTz.note,
      // Owner-local "today" derived server-side — the home view keys off this
      // instead of a caller-computed day window (the retired startOfTodayIso hack).
      today: localToday(ownerTz.zone),
      since: since.toISOString(),
      until: until.toISOString(),
      days,
      // Same verbatim reference lines as the windowed mode (§ Daily targets).
      ...(dailyTargets !== undefined ? { targets: dailyTargets } : {}),
    };
  };

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
      return toView(record, ownerTz);
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
      return { expenditures: rows.map((r) => toView(r, ownerTz)), count: rows.length, tz: ownerTz.note };
    }
  );

  // GET /kitchen/expenditures/skipped - Strava activities the sync saw and
  // will never import (§ Skip visibility). Static path ahead of the `:ulid`
  // routes below, same convention as /kitchen/entries/questions. Never
  // stored — read straight from the live sync's current tick, so an absent
  // `stravaSync` (Strava not configured, or a test) is simply an empty list,
  // not an error.
  fastify.get('/kitchen/expenditures/skipped', async () => {
    const skipped = (stravaSync?.getSkipped() ?? []).map((a) => ({
      activity_id: a.activity_id,
      label: a.label,
      occurred_at: a.occurred_at ? a.occurred_at.toISOString() : null,
      day: a.occurred_at ? localDay(a.occurred_at, ownerTz.zone) : null,
      occurred_local: a.occurred_at ? localDisplay(a.occurred_at, ownerTz.zone) : null,
    }));
    return { skipped, count: skipped.length, tz: ownerTz.note };
  });

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

  // ── Net-energy summary ──────────────────────────────────────────────────────
  // Two modes on one endpoint:
  //  • windowed (default) — the legacy shape: a caller-supplied since/until
  //    window, one aggregate. Unchanged for existing callers.
  //  • day-grouped (`group=day`) — the module OWNS the day boundaries via the
  //    owner timezone (§ Timezone & local-day bucketing): one row per
  //    owner-local day over the window (panel + calories + net), so an agent
  //    asking "how did the week go" calls it once and never hand-buckets.
  // Intake sums EFFECTIVE calories (base × portion_multiplier, nulls skipped,
  // § Portion multiplier).
  fastify.get<{ Querystring: { since?: string; until?: string; group?: string } }>(
    '/kitchen/summary',
    async (request, reply) => {
      if (request.query.group === 'day') {
        return summaryByDay(request, reply);
      }

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
