import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { MemoryEntryStore, MemoryRecipeStore } from '../memory-store.js';
import { KitchenPipeline } from '../services/pipeline.js';
import { registerKitchenRoutes } from './kitchen.js';
import { resolveOwnerTz } from '../zoned.js';
import { generateUlid } from '../ulid.js';

/**
 * Entry rows (list + detail) carry the module-owned local-day fields
 * (specs/modules/kitchen.md § Timezone & local-day bucketing): `day` = the
 * owner-tz calendar date computed server-side, `logged_local` = the instant in
 * the owner zone, and the raw `logged_at` UTC instant retained for ordering.
 * Pinned to America/New_York for determinism.
 */
describe('entry rows carry owner-local `day` (§ Timezone & local-day bucketing)', () => {
  let fastify: FastifyInstance;
  let entries: MemoryEntryStore;

  beforeEach(async () => {
    fastify = Fastify({ logger: false });
    entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, fastify.log);
    await fastify.register(registerKitchenRoutes, { pipeline, ownerTz: resolveOwnerTz('America/New_York') });
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  const seed = async (loggedAt: string) => {
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
        calories: 500, protein_g: 30, fat_g: 20, sat_fat_g: 5, carbs_g: 40,
        sugar_g: 5, added_sugar_g: 2, fiber_g: 6, sodium_mg: 400, confidence: 0.9,
        portion_basis: 'plate',
      },
      'model',
      'estimated'
    );
    return ulid;
  };

  it('GET /kitchen/entries stamps day + logged_local on each row, keeps raw logged_at', async () => {
    // 2026-07-26T00:47Z → 2026-07-25 20:47 in NY (the meal is the 25th).
    const ulid = await seed('2026-07-26T00:47:00Z');
    const res = await fastify.inject({ method: 'GET', url: '/kitchen/entries' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tz).toBe('America/New_York');
    const row = body.entries.find((e: { ulid: string }) => e.ulid === ulid);
    expect(row.day).toBe('2026-07-25'); // owner-local, not the UTC 26th
    expect(row.logged_local).toBe('2026-07-25T20:47:00-04:00'); // owner zone, never a bare Z
    expect(row.logged_at).toBe('2026-07-26T00:47:00.000Z'); // raw instant retained for ordering
  });

  it('GET /kitchen/entries/:ulid detail carries the same day + logged_local', async () => {
    const ulid = await seed('2026-01-15T04:30:00Z'); // 2026-01-14 23:30 EST
    const res = await fastify.inject({ method: 'GET', url: `/kitchen/entries/${ulid}` });
    const body = res.json();
    expect(body.day).toBe('2026-01-14');
    expect(body.logged_local).toBe('2026-01-14T23:30:00-05:00'); // winter offset
  });
});
