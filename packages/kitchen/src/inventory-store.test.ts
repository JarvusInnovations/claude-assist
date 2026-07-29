/**
 * `InventoryStore.applyConversion` — the atomic write behind a prep transform
 * (§ Conversions § Atomicity). Exercised against `MemoryInventoryStore`, the
 * mirror of `PgInventoryStore` the rest of the suite runs on; the pg half's
 * `sql.begin` rollback is validated separately against a real Postgres (see
 * plans/convert-atomicity.md § Notes).
 *
 * The failure this guards is directional: a conversion that spends its sources
 * and then dies leaves the ledger claiming LESS stock than reality, which
 * nothing downstream flags, so it resurfaces later as unexplained drift.
 */

import { describe, expect, it } from 'bun:test';
import { MemoryInventoryStore } from './inventory-memory-store.js';
import type { ConversionWrite, NewItem } from './inventory-store.js';

const ULID = (n: number) => `01J${String(n).padStart(23, '0')}`.toUpperCase();

const SOURCE_A = ULID(1);
const SOURCE_B = ULID(2);
const DERIVED = ULID(3);
const DERIVATION = ULID(4);

function countedItem(ulid: string, overrides: Partial<NewItem> = {}): NewItem {
  return {
    ulid,
    product_ulid: null,
    raw_label: 'Sealed multipack',
    store: null,
    batch_ulid: null,
    state: 'stocked',
    on_hand_fraction: 1,
    units_total: 4,
    units_remaining: 4,
    needs_info: false,
    acquired_at: new Date('2026-07-10'),
    eat_by: new Date('2026-07-24'),
    shelf_life_class: 'fridge_long',
    notes: null,
    ...overrides,
  };
}

function fractionItem(ulid: string, overrides: Partial<NewItem> = {}): NewItem {
  return countedItem(ulid, {
    raw_label: 'Divisible tub',
    units_total: null,
    units_remaining: null,
    on_hand_fraction: 1,
    ...overrides,
  });
}

function derivedItem(): NewItem {
  return {
    ulid: DERIVED,
    product_ulid: null,
    raw_label: 'Prepped batch',
    store: null,
    batch_ulid: null,
    state: 'stocked',
    on_hand_fraction: 1,
    units_total: null,
    units_remaining: null,
    needs_info: false,
    acquired_at: new Date('2026-07-12'),
    eat_by: new Date('2026-07-16'),
    shelf_life_class: 'prepared',
    notes: null,
  };
}

/** A two-source conversion: 2 units off A, the whole remaining fraction off B. */
function twoSourceWrite(): ConversionWrite {
  return {
    sources: [
      { item_ulid: SOURCE_A, update: { state: 'stocked', units_remaining: 2 } },
      { item_ulid: SOURCE_B, update: { state: 'finished', closed_at: new Date('2026-07-12'), on_hand_fraction: 0 } },
    ],
    derived: derivedItem(),
    derivation: {
      ulid: DERIVATION,
      derived_item_ulid: DERIVED,
      sources: [
        { item_ulid: SOURCE_A, amount: 2, amount_kind: 'count' },
        { item_ulid: SOURCE_B, amount: 1, amount_kind: 'fraction' },
      ],
      recipe_ulid: null,
    },
  };
}

async function seedTwoSources(store: MemoryInventoryStore) {
  await store.insertItemIfAbsent(countedItem(SOURCE_A));
  await store.insertItemIfAbsent(fractionItem(SOURCE_B));
  return {
    a: structuredClone(store.items.get(SOURCE_A)!),
    b: structuredClone(store.items.get(SOURCE_B)!),
  };
}

describe('MemoryInventoryStore.applyConversion — atomic prep-transform write', () => {
  it('applies every write on the happy path: both sources decremented, derived item created, provenance recorded', async () => {
    const store = new MemoryInventoryStore();
    await seedTwoSources(store);

    const result = await store.applyConversion(twoSourceWrite());

    // Returned in the order supplied.
    expect(result.sources.map((s) => s.ulid)).toEqual([SOURCE_A, SOURCE_B]);
    expect(result.sources[0]!.units_remaining).toBe(2);
    expect(result.sources[0]!.state).toBe('stocked');
    expect(result.sources[1]!.state).toBe('finished');
    expect(result.sources[1]!.on_hand_fraction).toBe(0);
    expect(result.derived.ulid).toBe(DERIVED);
    expect(result.derived.raw_label).toBe('Prepped batch');
    expect(result.derivation.sources.map((s) => s.item_ulid)).toEqual([SOURCE_A, SOURCE_B]);

    // All three landed in the underlying maps, not just in the returned snapshot.
    expect(store.items.get(SOURCE_A)!.units_remaining).toBe(2);
    expect(store.items.get(SOURCE_B)!.state).toBe('finished');
    expect(store.items.has(DERIVED)).toBe(true);
    expect(store.derivations.get(DERIVED)!.ulid).toBe(DERIVATION);
  });

  it('PROVES atomicity: a failure before the derived insert leaves the sources UNSPENT', async () => {
    const store = new MemoryInventoryStore({
      beforeDerivedInsert: () => {
        throw new Error('simulated failure between the source decrements and the derived insert');
      },
    });
    const { a, b } = await seedTwoSources(store);

    await expect(store.applyConversion(twoSourceWrite())).rejects.toThrow('simulated failure');

    // This is the damaging case #156 names: without the transaction, the inputs
    // are gone and the output never existed.
    expect(store.items.get(SOURCE_A)).toEqual(a);
    expect(store.items.get(SOURCE_B)).toEqual(b);
    expect(store.items.has(DERIVED)).toBe(false);
    expect(store.derivations.has(DERIVED)).toBe(false);
  });

  it('rolls back ALL sources, not just the last one applied', async () => {
    const store = new MemoryInventoryStore({
      beforeDerivedInsert: () => {
        throw new Error('boom');
      },
    });
    const { a, b } = await seedTwoSources(store);

    await expect(store.applyConversion(twoSourceWrite())).rejects.toThrow('boom');

    // The FIRST source is the one a naive "undo what just failed" would miss.
    expect(store.items.get(SOURCE_A)!.units_remaining).toBe(a.units_remaining);
    expect(store.items.get(SOURCE_A)!.state).toBe(a.state);
    expect(store.items.get(SOURCE_B)!.on_hand_fraction).toBe(b.on_hand_fraction);
    expect(store.items.get(SOURCE_B)!.closed_at).toBeNull();
  });

  it('a failure before the derivation insert leaves NO derived item visible (never an orphan)', async () => {
    const store = new MemoryInventoryStore({
      beforeDerivationInsert: () => {
        throw new Error('simulated failure between the derived insert and the derivation insert');
      },
    });
    const { a, b } = await seedTwoSources(store);

    await expect(store.applyConversion(twoSourceWrite())).rejects.toThrow('simulated failure');

    // A derived item with no provenance would break cost attribution and
    // cross-transform reasoning, so the item goes back too — not just the row.
    expect(store.items.has(DERIVED)).toBe(false);
    expect(store.derivations.has(DERIVED)).toBe(false);
    expect(await store.getItem(DERIVED)).toBeNull();
    expect(store.items.get(SOURCE_A)).toEqual(a);
    expect(store.items.get(SOURCE_B)).toEqual(b);

    // And it is not merely invisible to reads — nothing was left behind.
    expect(await store.listItems({})).toHaveLength(2);
  });

  it('rolls back when the derivation insert itself fails (the pg UNIQUE derived_item_ulid mirror)', async () => {
    const store = new MemoryInventoryStore();
    const { a } = await seedTwoSources(store);

    // First conversion succeeds and claims the derived item's provenance.
    await store.applyConversion(twoSourceWrite());
    const afterFirst = structuredClone(store.items.get(SOURCE_A)!);
    const derivationAfterFirst = structuredClone(store.derivations.get(DERIVED)!);

    // A replay reuses the derived ULID: `insertItemIfAbsent` no-ops, then the
    // derivation insert collides — exactly the pg constraint's shape.
    await expect(store.applyConversion(twoSourceWrite())).rejects.toThrow(/derivation for derived item/);

    // The replay's decrements are undone (A is not spent twice), and the FIRST
    // conversion's derived item and provenance both survive intact.
    expect(store.items.get(SOURCE_A)).toEqual(afterFirst);
    expect(store.items.get(SOURCE_A)!.units_remaining).not.toBe(a.units_remaining);
    expect(store.items.has(DERIVED)).toBe(true);
    expect(store.derivations.get(DERIVED)).toEqual(derivationAfterFirst);
  });

  it('refuses a conversion naming an absent source and writes nothing at all', async () => {
    const store = new MemoryInventoryStore();
    await store.insertItemIfAbsent(countedItem(SOURCE_A));
    const a = structuredClone(store.items.get(SOURCE_A)!);

    await expect(store.applyConversion(twoSourceWrite())).rejects.toThrow(/not found/);

    expect(store.items.get(SOURCE_A)).toEqual(a);
    expect(store.items.has(DERIVED)).toBe(false);
    expect(store.derivations.size).toBe(0);
  });

  it('a source-less conversion still writes the derived item and its empty provenance', async () => {
    const store = new MemoryInventoryStore();

    const result = await store.applyConversion({
      sources: [],
      derived: derivedItem(),
      derivation: { ulid: DERIVATION, derived_item_ulid: DERIVED, sources: [], recipe_ulid: ULID(5) },
    });

    expect(result.sources).toEqual([]);
    expect(result.derived.ulid).toBe(DERIVED);
    expect(result.derivation.sources).toEqual([]);
    expect(result.derivation.recipe_ulid).toBe(ULID(5));
    expect(store.items.has(DERIVED)).toBe(true);
  });

  it('rolls one source back to its ORIGINAL state when a conversion spends it twice', async () => {
    const store = new MemoryInventoryStore({
      beforeDerivedInsert: () => {
        throw new Error('boom');
      },
    });
    await store.insertItemIfAbsent(countedItem(SOURCE_A));
    const a = structuredClone(store.items.get(SOURCE_A)!);

    // Two decrements against the same item, as the service plans them: 4 → 3 → 2.
    await expect(
      store.applyConversion({
        sources: [
          { item_ulid: SOURCE_A, update: { state: 'stocked', units_remaining: 3 } },
          { item_ulid: SOURCE_A, update: { state: 'stocked', units_remaining: 2 } },
        ],
        derived: derivedItem(),
        derivation: {
          ulid: DERIVATION,
          derived_item_ulid: DERIVED,
          sources: [
            { item_ulid: SOURCE_A, amount: 1, amount_kind: 'count' },
            { item_ulid: SOURCE_A, amount: 1, amount_kind: 'count' },
          ],
          recipe_ulid: null,
        },
      })
    ).rejects.toThrow('boom');

    // Not 3 — the snapshot is the pre-call state, not the state the first
    // decrement of the pair produced.
    expect(store.items.get(SOURCE_A)!.units_remaining).toBe(4);
    expect(store.items.get(SOURCE_A)).toEqual(a);
  });
});
