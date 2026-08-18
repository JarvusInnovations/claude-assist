import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { MemoryEntryStore, MemoryExpenditureStore } from '../memory-store.js';
import { registerExpenditureRoutes } from './expenditures.js';
import type { DailyTargets } from '../daily-targets.js';
import { generateUlid } from '../ulid.js';

describe('expenditure routes (§ Expenditure & net energy)', () => {
  let fastify: FastifyInstance;
  let store: MemoryExpenditureStore;
  let entries: MemoryEntryStore;

  const build = async (tdeeBase?: number, dailyTargets?: DailyTargets) => {
    fastify = Fastify({ logger: false });
    store = new MemoryExpenditureStore();
    entries = new MemoryEntryStore();
    await fastify.register(registerExpenditureRoutes, { store, entries, tdeeBase, dailyTargets });
    await fastify.ready();
  };

  afterEach(async () => {
    await fastify.close();
  });

  it('POST records a stated burn, idempotent on ulid; DELETE removes it', async () => {
    await build();
    const ulid = generateUlid();
    const body = { ulid, occurred_at: '2026-07-22T01:00:00Z', source: 'manual', label: 'Evening ride', kcal: 450, duration_min: 60, avg_hr: 138 };

    const first = await fastify.inject({ method: 'POST', url: '/kitchen/expenditures', payload: body });
    expect(first.statusCode).toBe(201);
    expect(first.json().kcal).toBe(450);

    const replay = await fastify.inject({ method: 'POST', url: '/kitchen/expenditures', payload: body });
    expect(replay.statusCode).toBe(200); // idempotent replay, no duplicate

    const list = await fastify.inject({ method: 'GET', url: '/kitchen/expenditures' });
    expect(list.json().count).toBe(1);

    const del = await fastify.inject({ method: 'DELETE', url: `/kitchen/expenditures/${ulid}` });
    expect(del.statusCode).toBe(200);
    const missing = await fastify.inject({ method: 'DELETE', url: `/kitchen/expenditures/${ulid}` });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects an unknown source and a bad occurred_at', async () => {
    await build();
    const bad = await fastify.inject({
      method: 'POST',
      url: '/kitchen/expenditures',
      payload: { occurred_at: '2026-07-22T01:00:00Z', source: 'fitbit', label: 'x', kcal: 10 },
    });
    expect(bad.statusCode).toBe(400);
    const badDate = await fastify.inject({
      method: 'POST',
      url: '/kitchen/expenditures',
      payload: { occurred_at: 'not-a-date', source: 'manual', label: 'x', kcal: 10 },
    });
    expect(badDate.statusCode).toBe(400);
  });

  // specs/modules/kitchen.md § Request validation is strict, not permissive —
  // the same silent-strip defect fixed on the products PATCH applies to every
  // schema-validated body in the module (Fastify's default AJV compiler
  // removes an unmatched key instead of rejecting it); this proves the fix is
  // installed here too, not just on the route that happened to get reported.
  it('rejects an unrecognized body key rather than silently dropping it', async () => {
    await build();
    const res = await fastify.inject({
      method: 'POST',
      url: '/kitchen/expenditures',
      payload: { occurred_at: '2026-07-22T01:00:00Z', source: 'manual', label: 'x', kcal: 10, notes: 'typo for label' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('"notes"');
  });

  it('summary computes net = (tdee_base + burns) − intake over the window', async () => {
    await build(2300);
    // Intake: one 500-kcal entry at multiplier 0.5 → 250 effective.
    const entryUlid = generateUlid();
    await entries.insertIfAbsent({ ulid: entryUlid, logged_at: new Date('2026-07-22T12:00:00Z'), note: 'lunch', recipe_ulid: null, component_quantities: null, notes_reviewed: true });
    await entries.applyEstimate(entryUlid, 'Lunch', {
      calories: 500, protein_g: 30, fat_g: 20, sat_fat_g: 5, carbs_g: 40,
      sugar_g: 5, added_sugar_g: 2, fiber_g: 6, sodium_mg: 400, confidence: 0.9, portion_basis: 'plate',
    }, 'model', 'estimated');
    await entries.applyPortionMultiplier(entryUlid, 0.5);

    await fastify.inject({
      method: 'POST', url: '/kitchen/expenditures',
      payload: { occurred_at: '2026-07-22T22:00:00Z', source: 'manual', label: 'Ride', kcal: 400 },
    });
    // A burn OUTSIDE the window must not count.
    await fastify.inject({
      method: 'POST', url: '/kitchen/expenditures',
      payload: { occurred_at: '2026-07-23T02:00:00Z', source: 'manual', label: 'Next-day run', kcal: 999 },
    });

    const res = await fastify.inject({
      method: 'GET',
      url: '/kitchen/summary?since=2026-07-22T00:00:00Z&until=2026-07-23T00:00:00Z',
    });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.intake_kcal).toBe(250); // effective, not base
    expect(s.expenditure_kcal).toBe(400);
    expect(s.expenditure_count).toBe(1);
    expect(s.tdee_base_kcal).toBe(2300);
    expect(s.net_kcal).toBe(2300 + 400 - 250);
  });

  it('summary OMITS the net fields when no TDEE base is configured — never guesses', async () => {
    await build(undefined);
    const res = await fastify.inject({
      method: 'GET',
      url: '/kitchen/summary?since=2026-07-22T00:00:00Z&until=2026-07-23T00:00:00Z',
    });
    const s = res.json();
    expect(s.intake_kcal).toBe(0);
    expect(s.expenditure_kcal).toBe(0);
    expect('tdee_base_kcal' in s).toBe(false);
    expect('net_kcal' in s).toBe(false);
  });

  it('summary serves configured daily targets VERBATIM — raw config, even with burns logged (§ Daily targets framing rule)', async () => {
    const targets: DailyTargets = { calories: { max: 1000 }, fiber_g: { min: 42 } };
    await build(2300, targets);
    // A burn on the day must not touch the targets block — the calories
    // target is static and intake-managed, never adjusted by expenditure.
    await fastify.inject({
      method: 'POST', url: '/kitchen/expenditures',
      payload: { occurred_at: '2026-07-22T22:00:00Z', source: 'manual', label: 'Ride', kcal: 400 },
    });

    const res = await fastify.inject({
      method: 'GET',
      url: '/kitchen/summary?since=2026-07-22T00:00:00Z&until=2026-07-23T00:00:00Z',
    });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.expenditure_kcal).toBe(400);
    expect(s.targets).toEqual({ calories: { max: 1000 }, fiber_g: { min: 42 } });
    // Verbatim means verbatim: no server-side remaining, no burn-adjusted line.
    expect('remaining' in s.targets.calories).toBe(false);
    expect(s.targets.calories.max).toBe(1000);
  });

  it('summary OMITS the targets key entirely when unconfigured — absent, not null or {}', async () => {
    await build(2300);
    const res = await fastify.inject({
      method: 'GET',
      url: '/kitchen/summary?since=2026-07-22T00:00:00Z&until=2026-07-23T00:00:00Z',
    });
    expect('targets' in res.json()).toBe(false);
  });

  it('summary requires the window', async () => {
    await build(2300);
    const res = await fastify.inject({ method: 'GET', url: '/kitchen/summary' });
    expect(res.statusCode).toBe(400);
  });
});

// § Skip visibility (claude-assist#214) — Strava activities the sync will
// never import, surfaced live from the (optional) `stravaSync` dependency.
describe('GET /kitchen/expenditures/skipped (§ Skip visibility)', () => {
  let fastify: FastifyInstance;

  afterEach(async () => {
    await fastify.close();
  });

  it('an absent stravaSync (Strava not configured) reports an empty list, not an error', async () => {
    fastify = Fastify({ logger: false });
    await fastify.register(registerExpenditureRoutes, {
      store: new MemoryExpenditureStore(),
      entries: new MemoryEntryStore(),
    });
    await fastify.ready();

    const res = await fastify.inject({ method: 'GET', url: '/kitchen/expenditures/skipped' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ skipped: [], count: 0 });
  });

  it('surfaces the live sync skip list with owner-local day fields, never a stored row', async () => {
    fastify = Fastify({ logger: false });
    const stravaSync = {
      getSkipped: () => [
        { activity_id: 1010, label: 'Pool Swim', occurred_at: new Date('2026-07-25T14:00:00Z') },
        { activity_id: 1011, label: 'Unknown Start', occurred_at: null },
      ],
    };
    await fastify.register(registerExpenditureRoutes, {
      store: new MemoryExpenditureStore(),
      entries: new MemoryEntryStore(),
      stravaSync,
    });
    await fastify.ready();

    const res = await fastify.inject({ method: 'GET', url: '/kitchen/expenditures/skipped' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(2);
    expect(body.skipped[0]).toMatchObject({
      activity_id: 1010,
      label: 'Pool Swim',
      occurred_at: '2026-07-25T14:00:00.000Z',
    });
    expect(typeof body.skipped[0].day).toBe('string');
    expect(typeof body.skipped[0].occurred_local).toBe('string');
    // No ulid/kcal — this is never a stored expenditure row.
    expect('ulid' in body.skipped[0]).toBe(false);
    expect('kcal' in body.skipped[0]).toBe(false);
    // A null start instant reports null day/local fields rather than guessing.
    expect(body.skipped[1]).toMatchObject({ activity_id: 1011, occurred_at: null, day: null, occurred_local: null });
  });
});
