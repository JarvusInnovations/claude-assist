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
