/**
 * Inventory dates bucket by the owner timezone (claude-assist#184).
 *
 * The defect: every server-derived inventory date was stamped from the UTC
 * calendar day, while the journal entry for the same act bucketed by the owner
 * zone. In a western-hemisphere instance any evening event has already crossed
 * into the next UTC day, so an item finished at dinner closed on tomorrow's
 * date — silently, and unfixably once the item went terminal.
 *
 * DETERMINISM: every clock here is seeded. The pipeline takes an injected
 * `now`, and each `at` is either a bare calendar date or a full instant with an
 * explicit offset. Nothing reads the wall clock and nothing measures a trailing
 * window from it, so no assertion below can rot into a passing-today failure.
 */

import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { MemoryInventoryStore } from '../inventory-memory-store.js';
import { MemoryEntryStore } from '../memory-store.js';
import { MemoryConsumeStore } from './consume-memory-store.js';
import { InventoryPipeline } from './inventory.js';
import { resolveOwnerTz } from '../zoned.js';
import type { RecipeRecord } from '../types.js';

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => log,
  level: 'silent',
} as unknown as FastifyBaseLogger;

const ULID = (n: number) => `01J${String(n).padStart(23, '0')}`.toUpperCase();

/**
 * 21:31 on 2026-08-03 in a −04:00 instance. As a UTC instant it is already
 * 01:31 on the 4th — the reported reproduction, and the single fact every
 * assertion in this file turns on.
 */
const EVENING_LOCAL = '2026-08-03T21:31:00-04:00';
const EVENING_INSTANT = new Date('2026-08-04T01:31:00Z');
const LOCAL_DAY = '2026-08-03';
const UTC_DAY = '2026-08-04'; // what the defect produced

/** A pipeline in a −04:00 instance whose clock is pinned to that evening. */
function harness(opts: { recipes?: RecipeRecord[] } = {}) {
  const store = new MemoryInventoryStore();
  const entries = new MemoryEntryStore();
  const pipeline = new InventoryPipeline(store, null, null, log, {
    ownerTz: resolveOwnerTz('America/New_York'),
    now: () => EVENING_INSTANT,
    consumeStore: new MemoryConsumeStore(entries, store),
    resolveRecipe: async (ulid) => opts.recipes?.find((r) => r.ulid === ulid) ?? null,
  });
  return { store, entries, pipeline };
}

/** The same instance with no zone configured — the stated UTC fallback. */
function utcHarness() {
  const store = new MemoryInventoryStore();
  const pipeline = new InventoryPipeline(store, null, null, log, {
    ownerTz: resolveOwnerTz(),
    now: () => EVENING_INSTANT,
  });
  return { store, pipeline };
}

describe('inventory event dates bucket by the owner timezone (#184)', () => {
  it('a finish fired in the local evening closes on the local day, not the next UTC day', async () => {
    const { pipeline } = harness();
    const { item } = await pipeline.createItem({
      raw_label: 'Soymilk',
      shelf_life_class: 'fridge_short',
      acquired_at: '2026-07-28',
    });

    const finished = await pipeline.applyEvent(item.ulid, 'finished');
    expect(finished!.closed_at).toBe(LOCAL_DAY);
    expect(finished!.closed_at).not.toBe(UTC_DAY);
  });

  it('the UTC fallback still stamps the UTC day — a stated fallback, not a silent fix', async () => {
    const { pipeline } = utcHarness();
    const { item } = await pipeline.createItem({ raw_label: 'Soymilk', shelf_life_class: 'fridge_short' });
    const finished = await pipeline.applyEvent(item.ulid, 'finished');
    expect(finished!.closed_at).toBe(UTC_DAY);
    expect(pipeline.tz).toBe('UTC (KITCHEN_OWNER_TZ unset)');
  });

  it('an explicit local timestamp lands on the day its wall clock reads', async () => {
    const { pipeline } = harness();
    const { item } = await pipeline.createItem({ raw_label: 'Soymilk', shelf_life_class: 'fridge_short' });
    const finished = await pipeline.applyEvent(item.ulid, 'finished', { at: EVENING_LOCAL });
    expect(finished!.closed_at).toBe(LOCAL_DAY);
  });

  it('opening stamps the local day AND anchors eat_by there', async () => {
    const { pipeline } = harness();
    const { item } = await pipeline.createItem({
      raw_label: 'Yogurt',
      shelf_life_class: 'fridge_short',
      acquired_at: '2026-07-28',
    });

    const opened = await pipeline.applyEvent(item.ulid, 'opened');
    expect(opened!.opened_at).toBe(LOCAL_DAY);
    // Opened window for fridge_short is 7 days. Anchored a day late, every
    // downstream deadline slid with it — this is the off-by-one that mattered.
    expect(opened!.eat_by).toBe('2026-08-10');
  });

  it('a storage move stamps the local day, re-anchors eat_by there, and dates its audit note', async () => {
    const { pipeline } = harness();
    const { item } = await pipeline.createItem({
      raw_label: 'Chicken',
      shelf_life_class: 'frozen',
      acquired_at: '2026-07-01',
    });

    const moved = await pipeline.applyEvent(item.ulid, 'moved', { to: 'fridge_short' });
    expect(moved!.storage_moved_at).toBe(LOCAL_DAY);
    expect(moved!.eat_by).toBe('2026-08-17'); // move date + the 14-day unopened window
    expect(moved!.notes).toContain(`moved frozen→fridge_short ${LOCAL_DAY}`);
  });

  it('a toss dates its waste note on the local day (waste telemetry reads these)', async () => {
    const { pipeline } = harness();
    const { item } = await pipeline.createItem({ raw_label: 'Greens', shelf_life_class: 'produce' });

    const tossed = await pipeline.applyEvent(item.ulid, 'tossed', { fraction: 0.5 });
    expect(tossed!.notes).toContain(`tossed 0.5 ${LOCAL_DAY}`);
    expect(tossed!.notes).not.toContain(UTC_DAY);
  });

  it('a dismissal closes on the local day', async () => {
    const { pipeline } = harness();
    const { item } = await pipeline.createItem({ raw_label: 'Dish soap', shelf_life_class: 'pantry' });
    const resolution = await pipeline.dismissItem(item.ulid);
    expect(resolution!.item.closed_at).toBe(LOCAL_DAY);
  });

  it('a merge retires the loser on the local day', async () => {
    const { pipeline } = harness();
    const { item: survivor } = await pipeline.createItem({ raw_label: 'Feta', shelf_life_class: 'fridge_long' });
    const { item: loser } = await pipeline.createItem({ raw_label: 'Feta', shelf_life_class: 'fridge_long' });
    const result = await pipeline.mergeItems(loser.ulid, survivor.ulid);
    expect(result!.merged.closed_at).toBe(LOCAL_DAY);
  });

  it('a reconcile dates its summary note on the local day', async () => {
    const { pipeline } = harness();
    const { item } = await pipeline.createItem({ raw_label: 'Rice', shelf_life_class: 'pantry' });
    const reconciled = await pipeline.reconcileItem(item.ulid, { on_hand_fraction: 0.5 });
    expect(reconciled!.notes).toContain(`reconciled ${LOCAL_DAY}`);
  });

  it('a defaulted acquired_at is the local day, so the eat_by it anchors is too', async () => {
    const { pipeline } = harness();
    const { item } = await pipeline.createItem({ raw_label: 'Berries', shelf_life_class: 'produce' });
    expect(item.acquired_at).toBe(LOCAL_DAY);
    expect(item.eat_by).toBe('2026-08-10'); // produce, 7-day unopened window
  });

  it('a defaulted receipt purchased_at is the local day', async () => {
    const { pipeline } = harness();
    const { batch } = await pipeline.ingestReceipt({ ulid: ULID(1) }, []);
    expect(batch.purchased_at).toBe(LOCAL_DAY);
  });

  it('a reconcile-supplied opened_at is taken as the calendar day given', async () => {
    const { pipeline } = harness();
    const { item } = await pipeline.createItem({ raw_label: 'Milk', shelf_life_class: 'fridge_short' });
    const reconciled = await pipeline.reconcileItem(item.ulid, { state: 'open', opened_at: '2026-08-01' });
    expect(reconciled!.opened_at).toBe('2026-08-01');
  });

  it('a stated-weight eat closes and dates its consumption note on the local day', async () => {
    const { pipeline } = harness();
    const { item } = await pipeline.createItem({ raw_label: 'Hummus', shelf_life_class: 'fridge_short' });
    await pipeline.applyEvent(item.ulid, 'opened', { at: '2026-08-01' });
    const result = await pipeline.consumeStatedAmount(item.ulid, { fraction: 1 });
    expect(result!.item.closed_at).toBe(LOCAL_DAY);
    expect(result!.item.notes).toContain(`consumed 1 ${LOCAL_DAY}`);
  });

  it('days_until_eat_by counts from the local today, not the UTC one', async () => {
    const { pipeline } = harness();
    const { item } = await pipeline.createItem({
      raw_label: 'Salad',
      shelf_life_class: 'produce',
      acquired_at: '2026-08-01',
    });
    // eat_by = 2026-08-08; local today is the 3rd, so five days remain. Read
    // from the UTC day (the 4th) it would report four — an urgency the owner
    // does not actually have.
    expect(item.eat_by).toBe('2026-08-08');
    expect(item.days_until_eat_by).toBe(5);
    expect(item.age_days).toBe(2);
  });
});

describe('conversion + consume dates bucket by the owner timezone (#184)', () => {
  const RECIPE: RecipeRecord = {
    ulid: ULID(50),
    name: 'Overnight oats',
    components: [{ label: 'oats', default_qty_g: 100, per_100g: { calories: 380, protein_g: 13, sat_fat_g: 1.2 } }],
    source: 'pushed',
    created_at: EVENING_INSTANT,
    updated_at: EVENING_INSTANT,
    archived_at: null,
  };

  it('a convert fired in the local evening acquires (and ages) from the local day', async () => {
    const { pipeline } = harness({ recipes: [RECIPE] });
    const { item: oats } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry' });

    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: oats.ulid }],
      derived: { name: 'Overnight oats jar', units_total: 3, recipe_ulid: RECIPE.ulid },
    });
    expect(derived.acquired_at).toBe(LOCAL_DAY);
    expect(derived.eat_by).toBe('2026-08-07'); // prepared, 4-day window from the make date
  });

  it('a consume closes the item and logs its entry on the SAME local day', async () => {
    const { pipeline } = harness({ recipes: [RECIPE] });
    const { item: oats } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: oats.ulid }],
      derived: { name: 'Overnight oats jar', recipe_ulid: RECIPE.ulid },
    });

    const result = await pipeline.consume(derived.ulid, { ulid: ULID(60) });
    // The disagreement the issue reports, asserted from both sides at once:
    // the item's terminal date and the journal entry's day are one day.
    expect(result!.item.closed_at).toBe(LOCAL_DAY);
    expect(result!.entry.logged_at.toISOString()).toBe(EVENING_INSTANT.toISOString());
  });

  it('a bare --at on consume logs at local noon that day, never midnight UTC the evening before', async () => {
    const { pipeline } = harness({ recipes: [RECIPE] });
    const { item: oats } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: oats.ulid }],
      derived: { name: 'Overnight oats jar', recipe_ulid: RECIPE.ulid },
      at: '2026-08-01',
    });

    const result = await pipeline.consume(derived.ulid, { ulid: ULID(61), at: '2026-08-02' });
    expect(result!.item.closed_at).toBe('2026-08-02');
    // Noon EDT on the 2nd. `new Date('2026-08-02')` would have been midnight
    // UTC = 20:00 on the 1st locally, bucketing the meal a day early.
    expect(result!.entry.logged_at.toISOString()).toBe('2026-08-02T16:00:00.000Z');
  });
});
