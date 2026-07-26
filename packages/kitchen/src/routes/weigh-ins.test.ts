import { afterEach, describe, expect, it } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { MemoryWeighInStore } from '../memory-store.js';
import { registerWeighInRoutes, median, parseOffsetMinutes } from './weigh-ins.js';
import { generateUlid, ulidFromSeed } from '../ulid.js';

// ALL values in this file are synthetic — no real readings.

/** `YYYY-MM-DD` for `n` days before now (UTC) — keeps rows inside the
 *  GET /kitchen/weight window regardless of when the suite runs. Pinned to
 *  one NOW so a mid-test day rollover can't skew expectations. */
const NOW = Date.now();
function dayUtc(n: number): string {
  return new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);
}

describe('weigh-in routes (§ Weigh-ins)', () => {
  let fastify: FastifyInstance;
  let store: MemoryWeighInStore;

  const build = async () => {
    fastify = Fastify({ logger: false });
    store = new MemoryWeighInStore();
    await fastify.register(registerWeighInRoutes, { store });
    await fastify.ready();
  };

  afterEach(async () => {
    await fastify.close();
  });

  const post = (payload: Record<string, unknown>) =>
    fastify.inject({ method: 'POST', url: '/kitchen/weigh-ins', payload });

  const logAt = (occurred_at: string, weight_kg: number, extra: Record<string, unknown> = {}) =>
    post({ ulid: generateUlid(), occurred_at, weight_kg, source: 'manual', ...extra });

  it('POST is idempotent on a caller-supplied ulid: 201 create, 200 replay with the stored row', async () => {
    await build();
    const ulid = generateUlid();
    const body = { ulid, occurred_at: `${dayUtc(1)}T08:05:00Z`, weight_kg: 81.4, source: 'manual' };

    const first = await post(body);
    expect(first.statusCode).toBe(201);
    expect(first.json().weight_kg).toBe(81.4);
    expect(first.json().tz_offset_minutes).toBe(0);

    const replay = await post({ ...body, weight_kg: 99 }); // same ulid wins; no rewrite
    expect(replay.statusCode).toBe(200);
    expect(replay.json().ulid).toBe(ulid);
    expect(replay.json().weight_kg).toBe(81.4); // the STORED row comes back

    const list = await fastify.inject({ method: 'GET', url: '/kitchen/weigh-ins' });
    expect(list.json().count).toBe(1);
  });

  it('POST seeds the ulid from hc_uuid server-side; re-reads replay to the same row', async () => {
    await build();
    const hcUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const body = {
      hc_uuid: hcUuid,
      occurred_at: `${dayUtc(1)}T07:58:00-05:00`,
      weight_kg: 80.9,
      body_fat_pct: 21.5,
      source: 'com.example.scaleapp',
    };

    const first = await post(body);
    expect(first.statusCode).toBe(201);
    expect(first.json().ulid).toBe(ulidFromSeed(0, `healthconnect:${hcUuid}`));
    expect(first.json().tz_offset_minutes).toBe(-300);

    const replay = await post(body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().ulid).toBe(first.json().ulid);

    const list = await fastify.inject({ method: 'GET', url: '/kitchen/weigh-ins' });
    expect(list.json().count).toBe(1);
  });

  it('POST requires EXACTLY one of ulid / hc_uuid — both or neither is a 400', async () => {
    await build();
    const base = { occurred_at: `${dayUtc(1)}T08:00:00Z`, weight_kg: 80, source: 'manual' };

    const neither = await post(base);
    expect(neither.statusCode).toBe(400);
    expect(neither.json().error).toContain('exactly one');

    const both = await post({ ...base, ulid: generateUlid(), hc_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    expect(both.statusCode).toBe(400);
    expect(both.json().error).toContain('exactly one');
  });

  it('POST rejects a zone-naive occurred_at with a clear 400 — never guesses a zone', async () => {
    await build();
    const naive = await logAt(`${dayUtc(1)}T08:00:00`, 80);
    expect(naive.statusCode).toBe(400);
    expect(naive.json().error).toContain('explicit UTC offset');

    const bareDate = await logAt(dayUtc(1), 80);
    expect(bareDate.statusCode).toBe(400);

    // Explicit offsets in every accepted spelling pass.
    expect((await logAt(`${dayUtc(2)}T08:00:00Z`, 80)).statusCode).toBe(201);
    expect((await logAt(`${dayUtc(3)}T08:00:00-04:00`, 80)).statusCode).toBe(201);
    expect((await logAt(`${dayUtc(4)}T08:00:00+0530`, 80)).statusCode).toBe(201);
  });

  it('POST validates weight_kg positive and body_fat_pct within 0–100', async () => {
    await build();
    expect((await logAt(`${dayUtc(1)}T08:00:00Z`, 0)).statusCode).toBe(400);
    expect((await logAt(`${dayUtc(1)}T08:00:00Z`, -5)).statusCode).toBe(400);
    expect((await logAt(`${dayUtc(1)}T08:00:00Z`, 80, { body_fat_pct: 101 })).statusCode).toBe(400);
    expect((await logAt(`${dayUtc(1)}T08:00:00Z`, 80, { body_fat_pct: -1 })).statusCode).toBe(400);
    expect((await logAt(`${dayUtc(1)}T08:00:00Z`, 80, { body_fat_pct: 21.5 })).statusCode).toBe(201);
  });

  it('DELETE removes a reading; a second delete is a 404', async () => {
    await build();
    const ulid = generateUlid();
    await post({ ulid, occurred_at: `${dayUtc(1)}T08:00:00Z`, weight_kg: 80, source: 'manual' });

    const del = await fastify.inject({ method: 'DELETE', url: `/kitchen/weigh-ins/${ulid}` });
    expect(del.statusCode).toBe(200);
    const missing = await fastify.inject({ method: 'DELETE', url: `/kitchen/weigh-ins/${ulid}` });
    expect(missing.statusCode).toBe(404);
  });

  it('weight collapses a multi-reading morning to the day median; raw rows all remain', async () => {
    await build();
    const d = dayUtc(2);
    // Three same-morning repeats (odd count → middle value). Synthetic spread.
    await logAt(`${d}T07:55:00Z`, 81.9, { body_fat_pct: 22.0 });
    await logAt(`${d}T07:57:00Z`, 81.2); // no body fat — median of non-null only
    await logAt(`${d}T07:59:00Z`, 81.5, { body_fat_pct: 21.6 });

    const res = await fastify.inject({ method: 'GET', url: '/kitchen/weight?days=7' });
    expect(res.statusCode).toBe(200);
    const { daily } = res.json();
    expect(daily).toHaveLength(1);
    expect(daily[0].date).toBe(d);
    expect(daily[0].weight_kg).toBe(81.5); // median of 81.2, 81.5, 81.9
    expect(daily[0].body_fat_pct).toBe(21.8); // mean of middle two of [21.6, 22.0]
    expect(daily[0].readings).toBe(3);

    // Derivation is read-time only: the raw rows are untouched.
    const raw = await fastify.inject({ method: 'GET', url: '/kitchen/weigh-ins' });
    expect(raw.json().count).toBe(3);
  });

  it('an even reading count medians to the mean of the middle two', async () => {
    await build();
    const d = dayUtc(1);
    for (const w of [80.0, 80.6, 81.0, 84.0]) await logAt(`${d}T08:00:00Z`, w);

    const res = await fastify.inject({ method: 'GET', url: '/kitchen/weight?days=7' });
    expect(res.json().daily[0].weight_kg).toBe(80.8); // (80.6 + 81.0) / 2
  });

  it('buckets each reading by ITS OWN stored offset: a late-evening instant lands on the prior local day for a negative offset', async () => {
    await build();
    const d = dayUtc(3);
    // 23:30 local at -04:00 is 03:30Z the NEXT UTC day — the reading must
    // still bucket to its own local day, not the UTC (or server-zone) day.
    const res = await logAt(`${d}T23:30:00-04:00`, 82.0);
    const utcDay = res.json().occurred_at.slice(0, 10);
    expect(utcDay).not.toBe(d); // the instant really does cross UTC midnight
    expect(res.json().local_date).toBe(d);

    const weight = await fastify.inject({ method: 'GET', url: '/kitchen/weight?days=7' });
    const { daily } = weight.json();
    expect(daily).toHaveLength(1);
    expect(daily[0].date).toBe(d);
  });

  it('trend is a 7-day rolling mean over the daily values that exist — no interpolation across gaps', async () => {
    await build();
    // Synthetic dailies: days 4/3/2 recent, plus one stale reading 12 days
    // back that must fall OUT of every recent point's 7-day window.
    await logAt(`${dayUtc(12)}T08:00:00Z`, 90.0);
    await logAt(`${dayUtc(4)}T08:00:00Z`, 80.0);
    await logAt(`${dayUtc(3)}T08:00:00Z`, 82.0);
    await logAt(`${dayUtc(2)}T08:00:00Z`, 84.0);

    const res = await fastify.inject({ method: 'GET', url: '/kitchen/weight?days=30' });
    const { daily, trend } = res.json();
    expect(daily).toHaveLength(4);
    expect(trend).toHaveLength(4);

    const byDate = Object.fromEntries(trend.map((t: { date: string; weight_kg: number }) => [t.date, t.weight_kg]));
    expect(byDate[dayUtc(12)]).toBe(90.0); // alone in its window
    expect(byDate[dayUtc(4)]).toBe(80.0); // day 12 is 8 days earlier — outside the 7-day window
    expect(byDate[dayUtc(3)]).toBe(81.0); // (80 + 82) / 2
    expect(byDate[dayUtc(2)]).toBe(82.0); // (80 + 82 + 84) / 3 — gaps skipped, never interpolated
  });

  it('weight rejects a malformed days and defaults to 30', async () => {
    await build();
    expect((await fastify.inject({ method: 'GET', url: '/kitchen/weight?days=0' })).statusCode).toBe(400);
    expect((await fastify.inject({ method: 'GET', url: '/kitchen/weight?days=nope' })).statusCode).toBe(400);
    const res = await fastify.inject({ method: 'GET', url: '/kitchen/weight' });
    expect(res.statusCode).toBe(200);
    expect(res.json().days).toBe(30);
  });
});

describe('weigh-in helpers', () => {
  it('parseOffsetMinutes reads Z, ±HH:MM, and ±HHMM; null for naive values', () => {
    expect(parseOffsetMinutes('2026-01-15T08:30:00Z')).toBe(0);
    expect(parseOffsetMinutes('2026-01-15T08:30:00-05:00')).toBe(-300);
    expect(parseOffsetMinutes('2026-01-15T08:30:00+0530')).toBe(330);
    expect(parseOffsetMinutes('2026-01-15T08:30:00')).toBeNull();
    expect(parseOffsetMinutes('2026-01-15')).toBeNull();
  });

  it('median handles odd and even counts (even = mean of middle two)', () => {
    expect(median([3])).toBe(3);
    expect(median([81.9, 81.2, 81.5])).toBe(81.5);
    expect(median([80.0, 84.0, 80.6, 81.0])).toBe(80.8);
  });
});
