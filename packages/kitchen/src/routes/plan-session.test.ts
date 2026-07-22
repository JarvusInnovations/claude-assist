import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SessionSpawner, SpawnRecord, SpawnRequest } from '@jarvus/claude-assist-core';
import { MemoryEntryStore, MemoryRecipeStore } from '../memory-store.js';
import { MemoryInventoryStore } from '../inventory-memory-store.js';
import { KitchenPipeline } from '../services/pipeline.js';
import { InventoryPipeline } from '../services/inventory.js';
import { generateUlid } from '../ulid.js';
import { gatherPlanningContext, composePreloadPrompt } from '../services/plan-session.js';
import { registerPlanSessionRoutes } from './plan-session.js';
import type { NutritionFields } from '../types.js';

const NUL_NUTRITION = (over: Partial<NutritionFields>): NutritionFields => ({
  calories: null,
  protein_g: null,
  fat_g: null,
  sat_fat_g: null,
  carbs_g: null,
  sugar_g: null,
  fiber_g: null,
  sodium_mg: null,
  confidence: null,
  portion_basis: null,
  ...over,
});

/** Seed an already-estimated entry with macros (and optional portion multiplier). */
async function seedEstimated(
  entries: MemoryEntryStore,
  macros: Partial<NutritionFields>,
  opts: { loggedAt?: Date; multiplier?: number } = {},
): Promise<string> {
  const ulid = generateUlid();
  await entries.insertIfAbsent({
    ulid,
    logged_at: opts.loggedAt ?? new Date(),
    note: null,
    recipe_ulid: null,
    component_quantities: null,
  });
  await entries.applyEstimate(ulid, 'seeded meal', NUL_NUTRITION(macros), 'model', 'estimated');
  if (opts.multiplier !== undefined) await entries.applyPortionMultiplier(ulid, opts.multiplier);
  return ulid;
}

async function seedItem(
  store: MemoryInventoryStore,
  over: { raw_label: string; eat_by: Date | null; on_hand_fraction?: number; state?: 'stocked' | 'open' },
): Promise<void> {
  await store.insertItemIfAbsent({
    ulid: generateUlid(),
    product_ulid: null,
    raw_label: over.raw_label,
    store: null,
    batch_ulid: null,
    state: over.state ?? 'stocked',
    on_hand_fraction: over.on_hand_fraction ?? 1,
    needs_info: false,
    acquired_at: new Date(),
    eat_by: over.eat_by,
    shelf_life_class: null,
    notes: null,
  });
}

describe('plan-session context builder', () => {
  let entries: MemoryEntryStore;
  let recipes: MemoryRecipeStore;
  let invStore: MemoryInventoryStore;
  let pipeline: KitchenPipeline;
  let inventory: InventoryPipeline;

  beforeEach(() => {
    const log = Fastify({ logger: false }).log;
    entries = new MemoryEntryStore();
    recipes = new MemoryRecipeStore();
    invStore = new MemoryInventoryStore();
    pipeline = new KitchenPipeline(entries, recipes, null, log);
    inventory = new InventoryPipeline(invStore, null, null, log);
  });

  it('computes EFFECTIVE totals (base × portion_multiplier) over today’s estimated entries', async () => {
    // 400 kcal at full portion + 400 kcal base at 0.5 → 400 + 200 = 600.
    await seedEstimated(entries, { calories: 400, protein_g: 30 });
    await seedEstimated(entries, { calories: 400, protein_g: 30 }, { multiplier: 0.5 });
    // An entry still estimating must NOT count toward totals.
    const pendingUlid = generateUlid();
    await entries.insertIfAbsent({ ulid: pendingUlid, logged_at: new Date(), note: null, recipe_ulid: null, component_quantities: null });

    const ctx = await gatherPlanningContext({ pipeline, inventory });

    expect(ctx.totals.calories).toBe(600);
    expect(ctx.totals.protein_g).toBe(45);
    expect(ctx.pendingCount).toBe(1);
    expect(ctx.todayCount).toBe(3);
  });

  it('orders eat-first by eat_by ascending and drops depleted items', async () => {
    await seedItem(invStore, { raw_label: 'later', eat_by: new Date('2999-12-31') });
    await seedItem(invStore, { raw_label: 'soonest', eat_by: new Date('2000-01-01') });
    await seedItem(invStore, { raw_label: 'middle', eat_by: new Date('2500-06-15') });
    await seedItem(invStore, { raw_label: 'depleted', eat_by: new Date('2000-01-01'), on_hand_fraction: 0 });

    const ctx = await gatherPlanningContext({ pipeline, inventory });

    expect(ctx.eatFirst.map((i) => i.label)).toEqual(['soonest', 'middle', 'later']);
  });

  it('composePreloadPrompt reflects the state and instructs a warm meal-planning takeover', async () => {
    await seedEstimated(entries, { calories: 500, protein_g: 40 });
    await seedItem(invStore, { raw_label: 'greek yogurt', eat_by: new Date('2000-01-02') });

    const ctx = await gatherPlanningContext({ pipeline, inventory });
    const prompt = composePreloadPrompt(ctx);

    expect(prompt).toContain('warm meal-planning session');
    expect(prompt).toContain('500 kcal');
    expect(prompt).toContain('greek yogurt');
    expect(prompt.toLowerCase()).toContain('when the human takes over');
  });
});

/** A fake spawner whose outcome + captured request the test controls. */
class FakeSpawner implements SessionSpawner {
  requests: SpawnRequest[] = [];
  constructor(private outcome: SpawnRecord) {}
  async spawn(request: SpawnRequest): Promise<SpawnRecord> {
    this.requests.push(request);
    return this.outcome;
  }
}

describe('POST /api/kitchen/plan-session', () => {
  let fastify: FastifyInstance;
  let pipeline: KitchenPipeline;
  let inventory: InventoryPipeline;

  async function build(spawner: SessionSpawner | null): Promise<void> {
    fastify = Fastify({ logger: false });
    const entries = new MemoryEntryStore();
    const recipes = new MemoryRecipeStore();
    const invStore = new MemoryInventoryStore();
    pipeline = new KitchenPipeline(entries, recipes, null, fastify.log);
    inventory = new InventoryPipeline(invStore, null, null, fastify.log);
    if (spawner) fastify.decorate('sessionSpawner', spawner);
    await fastify.register(registerPlanSessionRoutes, { pipeline, inventory });
    await fastify.ready();
  }

  afterEach(async () => {
    await fastify?.close();
  });

  it('happy path: 200 ack with spawn_id, never the link', async () => {
    const spawner = new FakeSpawner({ status: 'spawned', spawnId: 'SPAWN123', notificationId: 7 });
    await build(spawner);

    const res = await fastify.inject({ method: 'POST', url: '/kitchen/plan-session' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toEqual({ status: 'spawned', spawn_id: 'SPAWN123' });
    // No link (or any link-shaped string) anywhere in the response.
    expect(res.payload).not.toContain('http');
    expect(res.payload).not.toContain('session_');
    // The endpoint handed the spawner a real preload prompt.
    expect(spawner.requests[0]!.title).toBe('meal-planning');
    expect(spawner.requests[0]!.preloadPrompt).toContain('meal-planning');
    // Tags the request with the kitchen caller group.
    expect(spawner.requests[0]!.group).toBe('kitchen');
  });

  it('unconfigured (no sessionSpawner decorator): 503', async () => {
    await build(null);
    const res = await fastify.inject({ method: 'POST', url: '/kitchen/plan-session' });
    expect(res.statusCode).toBe(503);
    expect((res.json() as Record<string, unknown>).error).toBeTruthy();
  });

  it('spawner reports not_configured: 503', async () => {
    await build(new FakeSpawner({ status: 'not_configured', spawnId: 'X' }));
    const res = await fastify.inject({ method: 'POST', url: '/kitchen/plan-session' });
    expect(res.statusCode).toBe(503);
  });

  it('spawn failure: 502 ack-failed, no link, no reason leaked', async () => {
    const spawner = new FakeSpawner({ status: 'failed', spawnId: 'SPAWNFAIL', notificationId: 9, reason: 'auth expired' });
    await build(spawner);

    const res = await fastify.inject({ method: 'POST', url: '/kitchen/plan-session' });

    expect(res.statusCode).toBe(502);
    expect(res.json() as Record<string, unknown>).toEqual({ status: 'failed', spawn_id: 'SPAWNFAIL' });
    // The failure reason is not surfaced in the response, and no link.
    expect(res.payload).not.toContain('auth expired');
    expect(res.payload).not.toContain('http');
  });
});
