/**
 * Weigh-in routes (specs/modules/kitchen.md § Weigh-ins — scale data via the
 * capture app, claude-assist#121) — registered under /api/kitchen.
 *
 *   POST   /kitchen/weigh-ins        - one reading; idempotent (ulid or hc_uuid)
 *   GET    /kitchen/weigh-ins        - raw rows, newest first
 *   GET    /kitchen/weight           - derived: daily median + 7-day rolling trend
 *   DELETE /kitchen/weigh-ins/:ulid  - remove a bad reading
 *
 * Capture-verbatim, derive-in-code: every reading is a row (same-morning
 * repeats included); the daily-median collapse and trend live HERE in the
 * read path only — raw rows are never merged or rewritten. `occurred_at`
 * MUST carry an explicit UTC offset: the platform emits zone-naive local
 * timestamps and only the device knows its zone, so the poster attaches it
 * and a naive timestamp is a 400, never a guess. The offset is persisted
 * (tz_offset_minutes) because timestamptz normalizes to UTC — it's what
 * lets the daily bucketing honor each reading's OWN local day.
 *
 * Standing rule: the module serves the trend; retuning KITCHEN_TDEE_BASE or
 * any daily-targets line against it stays an owner/agent judgment loop — no
 * code path here (or anywhere in the module) auto-adjusts from weigh-ins.
 */

import type { FastifyPluginAsync } from 'fastify';
import { installStrictValidation } from '../strict-validation.js';
import { ULID_PATTERN, ulidFromSeed } from '../ulid.js';
import { coerceBareDateToLocalNoon } from '../date-coerce.js';
import type { WeighInRecord, WeighInStore } from '../store.js';
import { localDay, localDisplay, resolveOwnerTz, type OwnerTz } from '../zoned.js';

export interface WeighInRoutesConfig {
  store: WeighInStore;
  /**
   * Owner timezone (§ Timezone & local-day bucketing) — stamps each row's
   * owner-tz `day` + local-time display, consistent with entries/expenditures.
   * The derived `/kitchen/weight` collapse still buckets by each reading's OWN
   * stored offset (§ Weigh-ins). Optional so tests can omit it; absent ⇒ UTC.
   */
  ownerTz?: OwnerTz;
}

const POST_BODY_SCHEMA = {
  type: 'object',
  required: ['occurred_at', 'weight_kg', 'source'],
  additionalProperties: false,
  properties: {
    ulid: { type: 'string' },
    hc_uuid: { type: 'string', minLength: 1 },
    occurred_at: { type: 'string' },
    weight_kg: { type: 'number', exclusiveMinimum: 0 },
    body_fat_pct: { type: ['number', 'null'], minimum: 0, maximum: 100 },
    source: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

interface WeighInBody {
  ulid?: string;
  hc_uuid?: string;
  occurred_at: string;
  weight_kg: number;
  body_fat_pct?: number | null;
  source: string;
}

/** Trailing explicit-offset designator: Z, ±HH:MM, or ±HHMM. */
const OFFSET_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Extract the explicit UTC offset (minutes east of UTC) from an ISO
 * timestamp, or null when the value is zone-naive. The server never infers
 * a clock — a null here is the caller's 400.
 */
export function parseOffsetMinutes(value: string): number | null {
  const match = OFFSET_PATTERN.exec(value);
  if (!match) return null;
  const designator = match[1]!;
  if (designator === 'Z') return 0;
  const sign = designator.startsWith('-') ? -1 : 1;
  const digits = designator.slice(1).replace(':', '');
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
}

/**
 * The reading's own local calendar date (`YYYY-MM-DD`): the stored UTC
 * instant shifted by the reading's stored offset. No server-zone input.
 */
export function localDateOf(occurredAt: Date, tzOffsetMinutes: number): string {
  return new Date(occurredAt.getTime() + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Median; even count = mean of the middle two. Caller guarantees non-empty. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface DailyWeight {
  date: string;
  weight_kg: number;
  body_fat_pct: number | null;
  readings: number;
}

/**
 * Collapse raw readings into one entry per local day that has readings —
 * each reading bucketed by its OWN stored offset. weight_kg is the day's
 * median (same-morning repeats spread up to ~0.7 kg, and a median shrugs at
 * both repeats and the odd manual entry); body_fat_pct the median of the
 * day's non-null values. Ascending by date.
 */
export function collapseDaily(rows: WeighInRecord[]): DailyWeight[] {
  const byDay = new Map<string, WeighInRecord[]>();
  for (const row of rows) {
    const date = localDateOf(row.occurred_at, row.tz_offset_minutes);
    const bucket = byDay.get(date);
    if (bucket) bucket.push(row);
    else byDay.set(date, [row]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, readings]) => {
      const bodyFat = readings
        .map((r) => r.body_fat_pct)
        .filter((v): v is number => v !== null);
      return {
        date,
        weight_kg: round2(median(readings.map((r) => r.weight_kg))),
        body_fat_pct: bodyFat.length > 0 ? round2(median(bodyFat)) : null,
        readings: readings.length,
      };
    });
}

export interface TrendPoint {
  date: string;
  weight_kg: number;
}

/**
 * 7-day rolling mean over the daily medians: each point averages the daily
 * values whose date falls in the 7-calendar-day window ending on (and
 * including) that day. Only days that exist contribute — no interpolation,
 * no invention.
 */
export function rollingTrend(daily: DailyWeight[]): TrendPoint[] {
  const WINDOW_MS = 6 * 86_400_000; // window start = date − 6 days
  return daily.map((point) => {
    const end = Date.parse(point.date);
    const start = end - WINDOW_MS;
    const inWindow = daily.filter((d) => {
      const t = Date.parse(d.date);
      return t >= start && t <= end;
    });
    const mean = inWindow.reduce((sum, d) => sum + d.weight_kg, 0) / inWindow.length;
    return { date: point.date, weight_kg: round2(mean) };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toView(r: WeighInRecord, ownerTz: OwnerTz) {
  return {
    ulid: r.ulid,
    occurred_at: r.occurred_at.toISOString(),
    tz_offset_minutes: r.tz_offset_minutes,
    // `local_date` buckets by the reading's OWN device offset (§ Weigh-ins, the
    // basis for the daily-median collapse). `day` is the module-wide owner-tz
    // bucketing key (§ Timezone & local-day bucketing); `occurred_local` renders
    // the instant in the owner zone (never a bare `Z`).
    local_date: localDateOf(r.occurred_at, r.tz_offset_minutes),
    day: localDay(r.occurred_at, ownerTz.zone),
    occurred_local: localDisplay(r.occurred_at, ownerTz.zone),
    weight_kg: r.weight_kg,
    body_fat_pct: r.body_fat_pct,
    source: r.source,
    created_at: r.created_at.toISOString(),
  };
}

function parseIso(value: string | undefined): Date | null | 'invalid' {
  if (value === undefined) return null;
  // Query-filter timestamps (since) may be bare dates — they coerce to local
  // noon like every other filter. Stored occurred_at is stricter (see POST).
  const d = new Date(coerceBareDateToLocalNoon(value));
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
}

export const registerWeighInRoutes: FastifyPluginAsync<WeighInRoutesConfig> = async (
  fastify,
  config
) => {
  // specs/modules/kitchen.md § Request validation is strict, not permissive
  installStrictValidation(fastify);

  const { store } = config;
  const ownerTz = config.ownerTz ?? resolveOwnerTz();

  fastify.post<{ Body: WeighInBody }>(
    '/kitchen/weigh-ins',
    { schema: { body: POST_BODY_SCHEMA } },
    async (request, reply) => {
      const body = request.body;

      // Exactly one identity: a caller-supplied ulid (manual/agent rows) or
      // an hc_uuid the server seeds from (keeping the seed function
      // server-side means no client reimplements it).
      if ((body.ulid === undefined) === (body.hc_uuid === undefined)) {
        reply.status(400);
        return { error: 'Provide exactly one of ulid or hc_uuid' };
      }
      if (body.ulid !== undefined && !ULID_PATTERN.test(body.ulid)) {
        reply.status(400);
        return { error: 'ulid must be a valid ULID' };
      }

      // Zone-naive timestamps are a 400, never a guess: the platform emits
      // naive local times and only the device knows its zone.
      const tzOffsetMinutes = parseOffsetMinutes(body.occurred_at);
      if (tzOffsetMinutes === null) {
        reply.status(400);
        return {
          error:
            'occurred_at must carry an explicit UTC offset (e.g. 2026-01-15T08:30:00-05:00 or ...Z) — the server never infers a zone',
        };
      }
      const occurredAt = new Date(body.occurred_at);
      if (Number.isNaN(occurredAt.getTime())) {
        reply.status(400);
        return { error: 'occurred_at must be a valid ISO date-time' };
      }

      if (!Number.isFinite(body.weight_kg) || body.weight_kg <= 0) {
        reply.status(400);
        return { error: 'weight_kg must be a positive finite number' };
      }

      const { record, created } = await store.insertIfAbsent({
        ulid: body.ulid ?? ulidFromSeed(0, `healthconnect:${body.hc_uuid}`),
        occurred_at: occurredAt,
        tz_offset_minutes: tzOffsetMinutes,
        weight_kg: body.weight_kg,
        body_fat_pct: body.body_fat_pct ?? null,
        source: body.source.trim(),
      });
      reply.status(created ? 201 : 200);
      return toView(record, ownerTz);
    }
  );

  fastify.get<{ Querystring: { since?: string; limit?: string } }>(
    '/kitchen/weigh-ins',
    async (request, reply) => {
      const since = parseIso(request.query.since);
      if (since === 'invalid') {
        reply.status(400);
        return { error: 'since must be an ISO date-time' };
      }
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      const rows = await store.list({ since: since ?? undefined, limit });
      return { weigh_ins: rows.map((r) => toView(r, ownerTz)), count: rows.length, tz: ownerTz.note };
    }
  );

  // ── Derived read: daily median + 7-day rolling trend ─────────────────────
  // Read-time and non-destructive — raw rows are never merged, deleted, or
  // "corrected" here. The window is the last N days of instants; each
  // reading then buckets to ITS OWN local day via its stored offset.
  fastify.get<{ Querystring: { days?: string } }>('/kitchen/weight', async (request, reply) => {
    const days = request.query.days === undefined ? 30 : parseInt(request.query.days, 10);
    if (!Number.isFinite(days) || days < 1 || days > 366) {
      reply.status(400);
      return { error: 'days must be an integer between 1 and 366' };
    }
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await store.list({ since, limit: 2000 });
    const daily = collapseDaily(rows);
    return { days, daily, trend: rollingTrend(daily) };
  });

  fastify.delete<{ Params: { ulid: string } }>('/kitchen/weigh-ins/:ulid', async (request, reply) => {
    const deleted = await store.delete(request.params.ulid);
    if (!deleted) {
      reply.status(404);
      return { error: 'Weigh-in not found' };
    }
    return { deleted: request.params.ulid };
  });
};
