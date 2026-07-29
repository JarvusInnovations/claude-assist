import { afterEach, describe, expect, it } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { MemoryEntryStore, MemoryExpenditureStore } from '../memory-store.js';
import { registerExpenditureRoutes } from './expenditures.js';
import { resolveOwnerTz } from '../zoned.js';
import { generateUlid } from '../ulid.js';
import type { NutritionFields } from '../types.js';

/**
 * Day-grouped summary (`group=day`) + the `day`/`occurred_local` row fields
 * (specs/modules/kitchen.md § Timezone & local-day bucketing). Everything is
 * pinned to America/New_York so bucketing is deterministic regardless of host
 * clock; the windowed mode and net-line behavior stay covered in
 * expenditures.test.ts.
 */
describe('summary group=day + module-owned local-day (§ Timezone & local-day bucketing)', () => {
  let fastify: FastifyInstance;
  let store: MemoryExpenditureStore;
  let entries: MemoryEntryStore;

  const build = async (opts: { tz?: string; tdeeBase?: number } = {}) => {
    fastify = Fastify({ logger: false });
    store = new MemoryExpenditureStore();
    entries = new MemoryEntryStore();
    await fastify.register(registerExpenditureRoutes, {
      store,
      entries,
      tdeeBase: opts.tdeeBase,
      ownerTz: resolveOwnerTz(opts.tz),
    });
    await fastify.ready();
  };

  afterEach(async () => {
    await fastify.close();
  });

  /** Seed an estimated entry with a full panel at a given instant + multiplier. */
  const seedEntry = async (loggedAt: string, panel: Partial<NutritionFields>, multiplier = 1) => {
    const ulid = generateUlid();
    await entries.insertIfAbsent({
      ulid,
      logged_at: new Date(loggedAt),
      note: 'meal',
      recipe_ulid: null,
      component_quantities: null,
    });
    await entries.applyEstimate(
      ulid,
      'Meal',
      {
        calories: null,
        protein_g: null,
        fat_g: null,
        sat_fat_g: null,
        carbs_g: null,
        sugar_g: null,
        added_sugar_g: null,
        fiber_g: null,
        sodium_mg: null,
        confidence: 0.9,
        portion_basis: 'plate',
        ...panel,
      },
      'model',
      'estimated'
    );
    if (multiplier !== 1) await entries.applyPortionMultiplier(ulid, multiplier);
    return ulid;
  };

  it('an entry at T00:47Z reports the owner-local day, not the UTC date', async () => {
    await build({ tz: 'America/New_York' });
    // 2026-07-26T00:47Z is 2026-07-25 20:47 in NY — the meal belongs to the 25th.
    await seedEntry('2026-07-26T00:47:00Z', { calories: 600, protein_g: 40 });

    const res = await fastify.inject({ method: 'GET', url: '/kitchen/summary?group=day' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.group).toBe('day');
    expect(body.tz).toBe('America/New_York');
    const days = body.days as Array<{ day: string; calories: number; entry_count: number }>;
    expect(days.length).toBe(1);
    expect(days[0]!.day).toBe('2026-07-25'); // local day, NOT 2026-07-26
    expect(days[0]!.calories).toBe(600);
    expect(days[0]!.entry_count).toBe(1);
  });

  it('per-day panel + calories + net over a window; effective totals, null-aware', async () => {
    await build({ tz: 'America/New_York', tdeeBase: 2300 });
    // Day A (2026-07-20 local): two entries, one at 0.5 multiplier.
    await seedEntry('2026-07-20T16:00:00Z', { calories: 500, protein_g: 30, fiber_g: 8, sodium_mg: 400 });
    await seedEntry('2026-07-20T23:00:00Z', { calories: 800, protein_g: 20, fiber_g: 4 }, 0.5); // → 400 kcal, 10 protein, 2 fiber
    // A burn on day A.
    await fastify.inject({
      method: 'POST',
      url: '/kitchen/expenditures',
      payload: { occurred_at: '2026-07-20T22:00:00Z', source: 'manual', label: 'Ride', kcal: 300 },
    });
    // Day B (2026-07-21 local): one entry, no sodium reported anywhere.
    await seedEntry('2026-07-21T15:00:00Z', { calories: 700, protein_g: 50, fiber_g: 10 });

    const res = await fastify.inject({
      method: 'GET',
      url: '/kitchen/summary?group=day&since=2026-07-19T00:00:00Z&until=2026-07-22T00:00:00Z',
    });
    const days = res.json().days as Array<{ day: string; [k: string]: number | string | null }>;
    expect(days.map((d) => d.day)).toEqual(['2026-07-20', '2026-07-21']); // ascending

    const a = days[0]!;
    expect(a.calories).toBe(900); // 500 + 400 effective
    expect(a.protein_g).toBe(40); // 30 + 10
    expect(a.fiber_g).toBe(10); // 8 + 2
    expect(a.sodium_mg).toBe(400); // only first entry carried it
    expect(a.fat_g).toBeNull(); // NO entry carried fat → null, not 0
    expect(a.entry_count).toBe(2);
    expect(a.expenditure_kcal).toBe(300);
    expect(a.tdee_base_kcal).toBe(2300);
    expect(a.net_kcal).toBe(2300 + 300 - 900); // (tdee + burn) − intake

    const b = days[1]!;
    expect(b.calories).toBe(700);
    expect(b.sodium_mg).toBeNull(); // day B never reported sodium
    expect(b.expenditure_kcal).toBe(0);
    expect(b.net_kcal).toBe(2300 + 0 - 700);
  });

  it('a week that mis-buckets under UTC buckets correctly under the owner zone', async () => {
    // Three late-evening meals (local) that each fall on the NEXT UTC day.
    await build({ tz: 'America/New_York' });
    await seedEntry('2026-06-02T01:30:00Z', { calories: 100 }); // Jun 1 21:30 local
    await seedEntry('2026-06-03T02:00:00Z', { calories: 200 }); // Jun 2 22:00 local
    await seedEntry('2026-06-04T03:15:00Z', { calories: 300 }); // Jun 3 23:15 local

    const res = await fastify.inject({
      method: 'GET',
      url: '/kitchen/summary?group=day&since=2026-05-30T00:00:00Z&until=2026-06-10T00:00:00Z',
    });
    const days = res.json().days as Array<{ day: string; calories: number }>;
    // Owner-zone bucketing: the 1st, 2nd, 3rd — NOT the 2nd/3rd/4th UTC dates.
    expect(days.map((d) => d.day)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
    expect(days.map((d) => d.calories)).toEqual([100, 200, 300]);

    // Contrast: the same data under UTC lands on the wrong days.
    await fastify.close();
    await build({ tz: 'UTC' });
    await seedEntry('2026-06-02T01:30:00Z', { calories: 100 });
    await seedEntry('2026-06-03T02:00:00Z', { calories: 200 });
    await seedEntry('2026-06-04T03:15:00Z', { calories: 300 });
    const utcRes = await fastify.inject({
      method: 'GET',
      url: '/kitchen/summary?group=day&since=2026-05-30T00:00:00Z&until=2026-06-10T00:00:00Z',
    });
    const utcDays = utcRes.json().days as Array<{ day: string }>;
    expect(utcDays.map((d) => d.day)).toEqual(['2026-06-02', '2026-06-03', '2026-06-04']);
  });

  it('DST spring-forward and fall-back days each bucket correctly', async () => {
    await build({ tz: 'America/New_York' });
    // Spring forward 2026-03-08: a meal at 06:30Z (01:30 EST) and one at 20:00Z (16:00 EDT) — same local day.
    await seedEntry('2026-03-08T06:30:00Z', { calories: 111 });
    await seedEntry('2026-03-08T20:00:00Z', { calories: 222 });
    // Fall back 2026-11-01: 05:30Z (01:30 EDT) and 18:00Z (13:00 EST) — same local day.
    await seedEntry('2026-11-01T05:30:00Z', { calories: 333 });
    await seedEntry('2026-11-01T18:00:00Z', { calories: 444 });

    const res = await fastify.inject({
      method: 'GET',
      url: '/kitchen/summary?group=day&since=2026-01-01T00:00:00Z&until=2026-12-31T00:00:00Z',
    });
    const days = res.json().days as Array<{ day: string; calories: number }>;
    const byDay = Object.fromEntries(days.map((d) => [d.day, d.calories]));
    expect(byDay['2026-03-08']).toBe(333); // 111 + 222
    expect(byDay['2026-11-01']).toBe(777); // 333 + 444
  });

  it('unset KITCHEN_OWNER_TZ ⇒ UTC fallback stated in the response tz note', async () => {
    await build({}); // no tz
    await seedEntry('2026-07-26T00:47:00Z', { calories: 500 });
    const res = await fastify.inject({ method: 'GET', url: '/kitchen/summary?group=day' });
    const body = res.json();
    expect(body.tz).toBe('UTC (KITCHEN_OWNER_TZ unset)');
    expect((body.days as Array<{ day: string }>)[0]!.day).toBe('2026-07-26'); // UTC date, stated
  });

  it('reports the owner-local "today" derived server-side', async () => {
    await build({ tz: 'America/New_York' });
    const res = await fastify.inject({ method: 'GET', url: '/kitchen/summary?group=day' });
    // `today` is a YYYY-MM-DD in the owner zone (not asserting the exact date to
    // stay clock-independent — just the shape and that it's server-provided).
    expect(res.json().today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('expenditure rows carry owner-local day + local-time display', async () => {
    await build({ tz: 'America/New_York' });
    await fastify.inject({
      method: 'POST',
      url: '/kitchen/expenditures',
      payload: { occurred_at: '2026-07-26T00:47:00Z', source: 'manual', label: 'Late ride', kcal: 200 },
    });
    const list = await fastify.inject({ method: 'GET', url: '/kitchen/expenditures' });
    const row = list.json().expenditures[0];
    expect(row.day).toBe('2026-07-25'); // owner-local, not the UTC 26th
    expect(row.occurred_local).toBe('2026-07-25T20:47:00-04:00'); // not a bare Z
    expect(row.occurred_at).toBe('2026-07-26T00:47:00.000Z'); // raw instant retained for ordering
  });

  it('rolls up added_sugar_g: an asserted 0 counts, an absent field stays null', async () => {
    await build({ tz: 'America/New_York' });
    // A fruit-and-dairy day: lots of TOTAL sugar, essentially no added sugar —
    // the exact day the retired total-sugar ceiling used to call a breach.
    await seedEntry('2026-07-20T13:00:00Z', { calories: 300, sugar_g: 32, added_sugar_g: 0 });
    await seedEntry('2026-07-20T17:00:00Z', { calories: 250, sugar_g: 24, added_sugar_g: 1.5 });
    // A different day where nothing carried added sugar at all.
    await seedEntry('2026-07-21T17:00:00Z', { calories: 400, sugar_g: 10 });

    const res = await fastify.inject({ method: 'GET', url: '/kitchen/summary?group=day&since=2026-07-19T00:00:00Z' });
    const days = res.json().days as Array<Record<string, string | number | null>>;
    const fruitDay = days.find((d) => d.day === '2026-07-20')!;
    const unknownDay = days.find((d) => d.day === '2026-07-21')!;

    expect(fruitDay.sugar_g).toBe(56);
    expect(fruitDay.added_sugar_g).toBe(1.5); // 0 + 1.5 — the asserted zero is a real summand
    // No entry carried it, so the day's total is UNKNOWN — never a fabricated
    // 0, which would read as a verified clean day (§ Nutrition panel).
    expect(unknownDay.sugar_g).toBe(10);
    expect(unknownDay.added_sugar_g).toBeNull();
  });

  it('scales added_sugar_g by the portion multiplier like every other panel field', async () => {
    await build({ tz: 'America/New_York' });
    await seedEntry('2026-07-20T17:00:00Z', { calories: 400, sugar_g: 30, added_sugar_g: 20 }, 0.5);
    const res = await fastify.inject({ method: 'GET', url: '/kitchen/summary?group=day&since=2026-07-19T00:00:00Z' });
    const day = res.json().days[0];
    expect(day.sugar_g).toBe(15);
    expect(day.added_sugar_g).toBe(10);
  });

  it('windowed mode is unchanged (a caller without group=day still gets one aggregate)', async () => {
    await build({ tz: 'America/New_York', tdeeBase: 2300 });
    await seedEntry('2026-07-20T16:00:00Z', { calories: 500 });
    const res = await fastify.inject({
      method: 'GET',
      url: '/kitchen/summary?since=2026-07-20T00:00:00Z&until=2026-07-21T00:00:00Z',
    });
    const s = res.json();
    expect(s.group).toBeUndefined();
    expect(s.intake_kcal).toBe(500);
    expect(s.net_kcal).toBe(2300 - 500);
  });
});
