import { describe, expect, it } from 'bun:test';
import { MemoryEntryStore } from '../memory-store.js';
import { MemoryInventoryStore } from '../inventory-memory-store.js';
import { MemoryConsumeStore } from './consume-memory-store.js';
import type { ConsumeEntryWrite } from './consume-store.js';
import type { NewItem } from '../inventory-store.js';

const ULID = (n: number) => `01J${String(n).padStart(23, '0')}`.toUpperCase();

function countedItem(overrides: Partial<NewItem> = {}): NewItem {
  return {
    ulid: ULID(1),
    product_ulid: null,
    raw_label: 'Overnight oats jar',
    store: null,
    batch_ulid: null,
    state: 'stocked',
    on_hand_fraction: 1,
    units_total: 3,
    units_remaining: 3,
    needs_info: false,
    acquired_at: new Date('2026-07-10'),
    eat_by: new Date('2026-07-15'),
    shelf_life_class: 'fridge_short',
    notes: null,
    ...overrides,
  };
}

function fractionItem(overrides: Partial<NewItem> = {}): NewItem {
  return {
    ulid: ULID(10),
    product_ulid: null,
    raw_label: 'Hummus tub',
    store: null,
    batch_ulid: null,
    state: 'open',
    on_hand_fraction: 0.6,
    units_total: null,
    units_remaining: null,
    needs_info: false,
    acquired_at: new Date('2026-07-10'),
    eat_by: new Date('2026-07-20'),
    shelf_life_class: 'fridge_short',
    notes: null,
    ...overrides,
  };
}

function entryWrite(overrides: Partial<ConsumeEntryWrite> = {}): ConsumeEntryWrite {
  return {
    ulid: ULID(2),
    logged_at: new Date('2026-07-17T12:00:00Z'),
    label: 'Overnight oats jar',
    nutrition: {
      calories: 300,
      protein_g: 15,
      fat_g: null,
      sat_fat_g: 4,
      carbs_g: null,
      sugar_g: null,
      added_sugar_g: null,
      fiber_g: null,
      sodium_mg: null,
      confidence: 1,
      portion_basis: 'recipe-computed',
    },
    source: 'reselect',
    status: 'estimated',
    inventory_item_ulid: ULID(1),
    ...overrides,
  };
}

describe('MemoryConsumeStore — atomic entry+deplete write (claude-assist#110)', () => {
  it('writes the entry and depletes the item together on a fresh consume', async () => {
    const entries = new MemoryEntryStore();
    const items = new MemoryInventoryStore();
    await items.insertItemIfAbsent(countedItem());
    const store = new MemoryConsumeStore(entries, items);

    const result = await store.consume(entryWrite(), ULID(1), {
      state: 'stocked',
      opened_at: null,
      units_remaining: 2,
    });

    expect(result.created).toBe(true);
    expect(result.entry.calories).toBe(300);
    expect(result.entry.source).toBe('reselect');
    expect(result.entry.status).toBe('estimated');
    expect(result.entry.inventory_item_ulid).toBe(ULID(1));
    expect(result.item.units_remaining).toBe(2);
    expect(result.item.state).toBe('stocked');

    // Both sides actually landed in the underlying stores, not just the
    // returned snapshot.
    expect(entries.records.get(ULID(2))?.calories).toBe(300);
    expect(items.items.get(ULID(1))?.units_remaining).toBe(2);
  });

  it('PROVES atomicity: a forced failure between the two writes leaves NEITHER applied', async () => {
    const entries = new MemoryEntryStore();
    const items = new MemoryInventoryStore();
    await items.insertItemIfAbsent(countedItem());
    const itemBefore = structuredClone(items.items.get(ULID(1))!);

    const store = new MemoryConsumeStore(entries, items, {
      beforeItemWrite: () => {
        throw new Error('simulated failure between entry insert and item deplete');
      },
    });

    await expect(
      store.consume(entryWrite(), ULID(1), { state: 'stocked', opened_at: null, units_remaining: 2 })
    ).rejects.toThrow('simulated failure');

    // Neither side committed: no entry row, and the item is byte-for-byte
    // what it was before the call (not "partially" depleted).
    expect(entries.records.has(ULID(2))).toBe(false);
    expect(items.items.get(ULID(1))).toEqual(itemBefore);
  });

  it('is idempotent on entry.ulid: a replay creates no duplicate entry and does not deplete again', async () => {
    const entries = new MemoryEntryStore();
    const items = new MemoryInventoryStore();
    await items.insertItemIfAbsent(countedItem());
    const store = new MemoryConsumeStore(entries, items);

    const write = entryWrite();
    const first = await store.consume(write, ULID(1), { state: 'stocked', opened_at: null, units_remaining: 2 });
    expect(first.created).toBe(true);
    expect(first.item.units_remaining).toBe(2);

    // Replay with the SAME entry ulid and a (deliberately different, to
    // prove it's ignored) item update — a genuine double-apply would show up
    // as units_remaining dropping to 1 or the update taking effect.
    const second = await store.consume(write, ULID(1), { state: 'finished', closed_at: new Date(), units_remaining: 0 });
    expect(second.created).toBe(false);
    expect(second.entry).toEqual(first.entry);
    expect(second.item.units_remaining).toBe(2); // unchanged — NOT re-applied
    expect(second.item.state).toBe('stocked');

    expect(entries.records.size).toBe(1);
  });

  it('peekEntry finds an existing entry without touching either store', async () => {
    const entries = new MemoryEntryStore();
    const items = new MemoryInventoryStore();
    await items.insertItemIfAbsent(countedItem());
    const store = new MemoryConsumeStore(entries, items);

    expect(await store.peekEntry(ULID(2))).toBeNull();
    await store.consume(entryWrite(), ULID(1), { state: 'stocked', opened_at: null, units_remaining: 2 });
    const peeked = await store.peekEntry(ULID(2));
    expect(peeked?.ulid).toBe(ULID(2));
    expect(peeked?.calories).toBe(300);
  });

  it('fraction-item depletion (finished semantics) applies atomically too', async () => {
    const entries = new MemoryEntryStore();
    const items = new MemoryInventoryStore();
    await items.insertItemIfAbsent(
      countedItem({ ulid: ULID(3), units_total: undefined, units_remaining: undefined, on_hand_fraction: 1 })
    );
    const store = new MemoryConsumeStore(entries, items);

    const result = await store.consume(
      entryWrite({ ulid: ULID(4), inventory_item_ulid: ULID(3) }),
      ULID(3),
      { state: 'finished', closed_at: new Date('2026-07-17'), on_hand_fraction: 0 }
    );

    expect(result.created).toBe(true);
    expect(result.item.state).toBe('finished');
    expect(result.item.on_hand_fraction).toBe(0);
    expect(result.item.closed_at).toEqual(new Date('2026-07-17'));
  });
});

describe('MemoryConsumeStore.linkConsumption — stated-weight consumption atomic link+deplete', () => {
  it('links an already-existing entry and depletes the item together, in one call', async () => {
    const entries = new MemoryEntryStore();
    const items = new MemoryInventoryStore();
    await items.insertItemIfAbsent(fractionItem());
    // The entry was ALREADY logged separately — linkConsumption never creates it.
    const { record: preExisting } = await entries.insertIfAbsent({ ulid: ULID(20), logged_at: new Date('2026-07-17T12:00:00Z'), note: null, recipe_ulid: null, component_quantities: null });
    expect(preExisting.inventory_item_ulid).toBeNull();
    const store = new MemoryConsumeStore(entries, items);

    const result = await store.linkConsumption(ULID(20), ULID(10), {
      state: 'open',
      on_hand_fraction: 0.4,
      notes: 'consumed 0.2 2026-07-17',
    });

    expect(result.linked).toBe(true);
    expect(result.entry.inventory_item_ulid).toBe(ULID(10));
    expect(result.item.on_hand_fraction).toBe(0.4);
    expect(result.item.notes).toBe('consumed 0.2 2026-07-17');

    // Both sides actually landed in the underlying stores.
    expect(entries.records.get(ULID(20))?.inventory_item_ulid).toBe(ULID(10));
    expect(items.items.get(ULID(10))?.on_hand_fraction).toBe(0.4);
  });

  it('PROVES atomicity: a forced failure between the link and the deplete leaves NEITHER applied', async () => {
    const entries = new MemoryEntryStore();
    const items = new MemoryInventoryStore();
    await items.insertItemIfAbsent(fractionItem());
    await entries.insertIfAbsent({ ulid: ULID(21), logged_at: new Date('2026-07-17T12:00:00Z'), note: null, recipe_ulid: null, component_quantities: null });
    const itemBefore = structuredClone(items.items.get(ULID(10))!);
    const entryBefore = structuredClone(entries.records.get(ULID(21))!);

    const store = new MemoryConsumeStore(entries, items, {
      beforeItemWrite: () => {
        throw new Error('simulated failure between entry link and item deplete');
      },
    });

    await expect(
      store.linkConsumption(ULID(21), ULID(10), { state: 'open', on_hand_fraction: 0.4 })
    ).rejects.toThrow('simulated failure');

    // Neither side committed: the entry is NOT linked, and the item is
    // byte-for-byte what it was before the call.
    expect(entries.records.get(ULID(21))).toEqual(entryBefore);
    expect(entries.records.get(ULID(21))?.inventory_item_ulid).toBeNull();
    expect(items.items.get(ULID(10))).toEqual(itemBefore);
  });

  it('is idempotent on entry_ulid: a replay neither re-links nor re-depletes', async () => {
    const entries = new MemoryEntryStore();
    const items = new MemoryInventoryStore();
    await items.insertItemIfAbsent(fractionItem());
    await entries.insertIfAbsent({ ulid: ULID(22), logged_at: new Date('2026-07-17T12:00:00Z'), note: null, recipe_ulid: null, component_quantities: null });
    const store = new MemoryConsumeStore(entries, items);

    const first = await store.linkConsumption(ULID(22), ULID(10), { state: 'open', on_hand_fraction: 0.4 });
    expect(first.linked).toBe(true);
    expect(first.item.on_hand_fraction).toBe(0.4);

    // Replay with the SAME entry ulid and a (deliberately different, to prove
    // it's ignored) item update — a genuine double-apply would show up as
    // on_hand_fraction dropping further.
    const second = await store.linkConsumption(ULID(22), ULID(10), { state: 'finished', closed_at: new Date(), on_hand_fraction: 0 });
    expect(second.linked).toBe(false);
    expect(second.entry).toEqual(first.entry);
    expect(second.item.on_hand_fraction).toBe(0.4); // unchanged — NOT re-applied
    expect(second.item.state).toBe('open');
  });

  it('throws on an entry already linked to a DIFFERENT item (a genuine conflict, not a replay)', async () => {
    const entries = new MemoryEntryStore();
    const items = new MemoryInventoryStore();
    await items.insertItemIfAbsent(fractionItem());
    await items.insertItemIfAbsent(fractionItem({ ulid: ULID(11) }));
    await entries.insertIfAbsent({ ulid: ULID(23), logged_at: new Date('2026-07-17T12:00:00Z'), note: null, recipe_ulid: null, component_quantities: null });
    const store = new MemoryConsumeStore(entries, items);

    await store.linkConsumption(ULID(23), ULID(10), { state: 'open', on_hand_fraction: 0.4 });

    await expect(
      store.linkConsumption(ULID(23), ULID(11), { state: 'open', on_hand_fraction: 0.4 })
    ).rejects.toThrow(/already linked to a different item/);
  });
});
