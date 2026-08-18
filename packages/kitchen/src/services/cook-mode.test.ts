/**
 * Cook mode (§ Cook mode) — the kitchen half of the worksheet seam.
 *
 * The two dispositions are covered as what they are: an **eaten** meal is a
 * directly-stated panel entry, a **packed** batch is a conversion. Getting that
 * backwards is the failure that matters — a pre-logged batch makes the journal
 * lie the moment plans change — so both the write it makes AND the write it
 * does NOT make are asserted.
 */

import { describe, expect, it } from 'bun:test';
import type { WorksheetCookRequest } from '@jarvus/claude-assist-core';
import {
  CookModeValidationError,
  KitchenCookMode,
  measuredNote,
  totalsToStatedMacros,
  type CookModeConverter,
  type CookModeEntryIngest,
} from './cook-mode.js';
import type { StatedMacros } from '../types.js';
import { MemoryEntryStore } from '../memory-store.js';
import { MemoryInventoryStore } from '../inventory-memory-store.js';
import { MemoryConsumeStore } from './consume-memory-store.js';
import { InventoryPipeline } from './inventory.js';

const KEY = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const RECIPE = '01JBBBBBBBBBBBBBBBBBBBBBBB';
const SOURCE = '01JCCCCCCCCCCCCCCCCCCCCCCC';

/** Records ingests and dedupes on ULID, exactly as `POST /entries` does. */
function fakeEntries() {
  const calls: { ulid: string; label?: string; note?: string; macros?: StatedMacros; logged_at?: string }[] = [];
  const written = new Set<string>();
  const entries: CookModeEntryIngest = {
    async ingest(input) {
      calls.push(input);
      const created = !written.has(input.ulid);
      written.add(input.ulid);
      return { record: { ulid: input.ulid }, created };
    },
  };
  return { entries, calls, written };
}

/** Records conversions and dedupes on the caller-supplied derived ULID. */
function fakeConverter() {
  const calls: Parameters<CookModeConverter['convert']>[0][] = [];
  const written = new Set<string>();
  const inventory: CookModeConverter = {
    async convert(input) {
      calls.push(input);
      const ulid = input.derived.ulid!;
      const created = !written.has(ulid);
      written.add(ulid);
      return { derived: { ulid }, created };
    },
  };
  return { inventory, calls, written };
}

function harness() {
  const entries = fakeEntries();
  const inventory = fakeConverter();
  return {
    entries,
    inventory,
    cook: new KitchenCookMode({ entries: entries.entries, inventory: inventory.inventory }),
  };
}

function request(overrides: Partial<WorksheetCookRequest> = {}): WorksheetCookRequest {
  return {
    ulid: KEY,
    disposition: 'eaten',
    label: 'grain bowl',
    unit: 'g',
    totals: { calories: 470, protein_g: 12, fiber_g: 4.5 },
    components: [
      { label: 'cooked grain', quantity: 187 },
      { label: 'dressing', quantity: 30 },
    ],
    ...overrides,
  };
}

describe('totalsToStatedMacros', () => {
  it('passes the known panel fields through verbatim', () => {
    expect(totalsToStatedMacros({ calories: 470, protein_g: 12.4 })).toEqual({
      calories: 470,
      protein_g: 12.4,
    });
  });

  it('omits an unknown total rather than storing 0 — unknown is not zero', () => {
    const panel = totalsToStatedMacros({ calories: 470, added_sugar_g: null });
    expect(panel).toEqual({ calories: 470 });
    expect('added_sugar_g' in panel).toBe(false);
  });

  it('keeps a stated 0 — an asserted zero is a real number', () => {
    expect(totalsToStatedMacros({ calories: 470, added_sugar_g: 0 })).toEqual({
      calories: 470,
      added_sugar_g: 0,
    });
  });

  it('REJECTS a field that is not a panel field instead of silently dropping it', () => {
    // Dropping it would log a meal whose numbers disagree with what the
    // submitter watched add up on screen.
    expect(() => totalsToStatedMacros({ calories: 470, vitamin_c_mg: 60 })).toThrow(
      /not a nutrition panel field/
    );
  });

  it('rejects a panel with nothing known in it', () => {
    expect(() => totalsToStatedMacros({ calories: null })).toThrow(CookModeValidationError);
  });
});

describe('measuredNote', () => {
  it('records the measured quantities as provenance', () => {
    expect(measuredNote(request())).toBe('worksheet: 187g cooked grain, 30g dressing');
  });

  it("leads with the submitter's own remark when there is one", () => {
    expect(measuredNote(request({ note: 'ran short on grain' }))).toBe(
      'ran short on grain\n\nworksheet: 187g cooked grain, 30g dressing'
    );
  });
});

describe('KitchenCookMode — eaten', () => {
  it('writes ONE born-manual entry carrying the stated panel', async () => {
    const { cook, entries, inventory } = harness();

    const outcome = await cook.cook(request());

    expect(outcome).toEqual({ kind: 'entry', ulid: KEY, created: true });
    expect(entries.calls).toHaveLength(1);
    expect(entries.calls[0]).toMatchObject({
      ulid: KEY,
      label: 'grain bowl',
      macros: { calories: 470, protein_g: 12, fiber_g: 4.5 },
    });
    // An eaten meal is an entry — it never converts anything.
    expect(inventory.calls).toHaveLength(0);
  });

  it('honors an explicit event time', async () => {
    const { cook, entries } = harness();
    await cook.cook(request({ at: '2026-07-27T18:30:00-04:00' }));
    expect(entries.calls[0]!.logged_at).toBe('2026-07-27T18:30:00-04:00');
  });

  it('is idempotent on the submission key', async () => {
    const { cook, entries } = harness();

    const first = await cook.cook(request());
    const replay = await cook.cook(request());

    expect(first.created).toBe(true);
    expect(replay).toEqual({ kind: 'entry', ulid: KEY, created: false });
    expect(entries.written.size).toBe(1);
  });
});

describe('KitchenCookMode — packed', () => {
  const packedRequest = (overrides: Partial<WorksheetCookRequest> = {}) =>
    request({
      disposition: 'packed',
      label: 'grain bowl jars',
      packed: { units: 3, shelf_life_class: 'prepared', recipe_ulid: RECIPE, sources: [{ item_ulid: SOURCE, amount: 0.5 }] },
      ...overrides,
    });

  it('records a conversion and posts NOTHING to the journal', async () => {
    const { cook, entries, inventory } = harness();

    const outcome = await cook.cook(packedRequest());

    expect(outcome).toEqual({ kind: 'item', ulid: KEY, created: true });
    // The load-bearing assertion: packing is not eating. No entry exists yet —
    // the batch is logged at eat time, via consume.
    expect(entries.calls).toHaveLength(0);
    expect(inventory.calls).toHaveLength(1);
    expect(inventory.calls[0]).toMatchObject({
      sources: [{ item_ulid: SOURCE, amount: 0.5 }],
      derived: {
        // The submission key IS the derived item's ULID — the idempotency key.
        ulid: KEY,
        name: 'grain bowl jars',
        units_total: 3,
        shelf_life_class: 'prepared',
        recipe_ulid: RECIPE,
      },
    });
    // Measured weights survive on the derived item as readable provenance.
    expect(inventory.calls[0]!.derived.notes).toContain('187g cooked grain');
  });

  it('handles a source-less batch (nothing tracked was spent)', async () => {
    const { cook, inventory } = harness();
    await cook.cook(packedRequest({ packed: { units: 2 } }));
    expect(inventory.calls[0]!.sources).toBeUndefined();
    expect(inventory.calls[0]!.derived.units_total).toBe(2);
  });

  it('is idempotent on the submission key — no second batch, no second decrement', async () => {
    const { cook, inventory } = harness();

    const first = await cook.cook(packedRequest());
    const replay = await cook.cook(packedRequest());

    expect(first.created).toBe(true);
    expect(replay).toEqual({ kind: 'item', ulid: KEY, created: false });
    expect(inventory.written.size).toBe(1);
  });

  it('rejects an unknown shelf-life class', async () => {
    const { cook } = harness();
    await expect(
      cook.cook(packedRequest({ packed: { shelf_life_class: 'eternal' } }))
    ).rejects.toThrow(CookModeValidationError);
  });

  it('rejects a non-panel total on a packed sheet too', async () => {
    const { cook, inventory } = harness();
    await expect(
      cook.cook(packedRequest({ totals: { calories: 470, vitamin_c_mg: 60 } }))
    ).rejects.toThrow(/not a nutrition panel field/);
    expect(inventory.calls).toHaveLength(0);
  });
});

describe('KitchenCookMode — request validation', () => {
  it('requires a ULID key', async () => {
    const { cook, entries } = harness();
    await expect(cook.cook(request({ ulid: 'not-a-ulid' }))).rejects.toThrow(
      CookModeValidationError
    );
    expect(entries.calls).toHaveLength(0);
  });

  it('requires a label', async () => {
    const { cook } = harness();
    await expect(cook.cook(request({ label: '   ' }))).rejects.toThrow(CookModeValidationError);
  });

  it('propagates a downstream write failure rather than swallowing it', async () => {
    // The pages module turns this into an explicit "NOT recorded" for the
    // submitter; silently resolving would put a green check over nothing.
    const cook = new KitchenCookMode({
      entries: {
        async ingest() {
          throw new Error('journal unreachable');
        },
      },
      inventory: fakeConverter().inventory,
    });
    await expect(cook.cook(request())).rejects.toThrow('journal unreachable');
  });
});

describe('cook mode — human note provenance (§ Unreviewed entry notes)', () => {
  it('flags the entry unreviewed ONLY when the submitter wrote free text', async () => {
    const withRemark = request();
    (withRemark as any).note = 'I put 4g of tabasco on the egg';
    const captured: any[] = [];
    const sink = new KitchenCookMode({
      entries: { ingest: async (input: any) => { captured.push(input); return { record: { ulid: input.ulid }, created: true }; } },
      inventory: { convert: async () => ({ item: { ulid: 'x' }, created: true }) } as any,
    });

    await sink.cook(withRemark as any);
    expect(captured[0].human_note).toBe(true);
    // The stored note keeps BOTH the remark and the measured manifest.
    expect(captured[0].note).toContain('tabasco');
    expect(captured[0].note).toContain('worksheet:');
  });

  it('does NOT flag when only the auto-generated manifest is present', async () => {
    const captured: any[] = [];
    const sink = new KitchenCookMode({
      entries: { ingest: async (input: any) => { captured.push(input); return { record: { ulid: input.ulid }, created: true }; } },
      inventory: { convert: async () => ({ item: { ulid: 'x' }, created: true }) } as any,
    });

    await sink.cook(request() as any);
    // The note is non-empty (the manifest is always appended), so note-presence
    // would flag EVERY cook-mode entry. Provenance is what distinguishes them.
    expect(captured[0].note).toContain('worksheet:');
    expect(captured[0].human_note).toBe(false);
  });
});

describe('eaten sheets decrement their sources (§ Eaten sheets decrement)', () => {
  const build = (over: any = {}) => {
    const calls: any = { stated: [], units: [], flagged: [] };
    const sink = new KitchenCookMode({
      entries: {
        ingest: async (input: any) => ({ record: { ulid: input.ulid }, created: true }),
        flagUnappliedDecrements: async (ulid: string, unapplied: string[]) => {
          calls.flagged.push({ ulid, unapplied });
        },
      },
      inventory: { convert: async () => ({ derived: { ulid: 'x' }, created: true }) } as any,
      depleter: {
        consumeStated: async (itemUlid: string, input: any) => {
          if (over.statedThrows) throw new Error(over.statedThrows);
          calls.stated.push({ itemUlid, ...input });
        },
        finishUnit: async (itemUlid: string) => {
          calls.units.push(itemUlid);
        },
      },
    });
    return { sink, calls };
  };

  const req = (over: any = {}) => ({
    ...(request() as any),
    disposition: 'eaten',
    components: [
      { label: 'yogurt', quantity: 186 },
      { label: 'egg', quantity: 1 },
    ],
    consumes: [
      { component: 'yogurt', item_ulid: 'item_yog', model: 'divisible' },
      { component: 'egg', item_ulid: 'item_egg', model: 'counted' },
    ],
    ...over,
  });

  it('decrements at the SUBMITTED quantity, not the planned one', async () => {
    const { sink, calls } = build();
    await sink.cook(req() as any);
    // 186 is what the human weighed — the sheet's default is irrelevant here.
    expect(calls.stated).toHaveLength(1);
    expect(calls.stated[0]).toMatchObject({ itemUlid: 'item_yog', amount_g: 186 });
    // And it links to the entry, so the depletion reads as consumption.
    expect(calls.stated[0].entry_ulid).toBe((req() as any).ulid);
  });

  it('takes whole units off a counted item, one call per unit', async () => {
    const { sink, calls } = build();
    await sink.cook(req({ components: [{ label: 'egg', quantity: 3 }], consumes: [{ component: 'egg', item_ulid: 'item_egg', model: 'counted' }] }) as any);
    expect(calls.units).toEqual(['item_egg', 'item_egg', 'item_egg']);
  });

  it('REPORTS a refused decrement instead of swallowing it', async () => {
    // The commonest cause is the module refusing to guess a mass basis. That
    // refusal is correct; making it visible is the point.
    const { sink, calls } = build({ statedThrows: 'net_content_g is required' });
    await sink.cook(req() as any);
    expect(calls.flagged).toHaveLength(1);
    expect(calls.flagged[0].unapplied[0]).toContain('yogurt');
    expect(calls.flagged[0].unapplied[0]).toContain('net_content_g');
  });

  it('logs the meal even when every decrement fails', async () => {
    const { sink } = build({ statedThrows: 'nope' });
    const outcome = await sink.cook(req() as any);
    // Logging must beat not-logging: inventory is reconcilable, a lost meal is not.
    expect(outcome).toMatchObject({ kind: 'entry', created: true });
  });

  it('skips a zero quantity without reporting it as a failure', async () => {
    const { sink, calls } = build();
    await sink.cook(req({ components: [{ label: 'yogurt', quantity: 0 }], consumes: [{ component: 'yogurt', item_ulid: 'item_yog', model: 'divisible' }] }) as any);
    expect(calls.stated).toHaveLength(0);
    expect(calls.flagged).toHaveLength(0);
  });

  it('decrements nothing when the sheet carries no bindings', async () => {
    const { sink, calls } = build();
    await sink.cook(req({ consumes: undefined }) as any);
    expect(calls.stated).toHaveLength(0);
    expect(calls.units).toHaveLength(0);
  });
});

describe('a multi-component eaten sheet decrements EVERY bound component (claude-assist#215)', () => {
  /**
   * The one test the stubbed depleter above structurally cannot make: cook mode
   * driving the REAL inventory pipeline, which is where the single-column link
   * lived. Six divisible components, all bound, one entry.
   *
   * Under `entries.inventory_item_ulid`, the first binding claimed the entry's
   * one link slot and the remaining five were refused as conflicts with it —
   * exactly what a live six-component sheet did (two applied, four flagged).
   */
  const log = { warn() {}, error() {}, info() {}, debug() {} } as any;

  async function realDepleterHarness(componentCount: number) {
    const store = new MemoryInventoryStore();
    const entryStore = new MemoryEntryStore();
    const pipeline = new InventoryPipeline(store, null, null, log, {
      consumeStore: new MemoryConsumeStore(entryStore, store),
      resolveRecipe: async () => null,
      linkEntry: (entryUlid, itemUlid, applied) =>
        entryStore.linkInventoryItem(entryUlid, itemUlid, applied),
    });

    // Each component is a divisible item with a real mass basis, so nothing is
    // refused for the legitimate reason (§ The basis rule: refuse, never infer).
    const items: string[] = [];
    for (let i = 0; i < componentCount; i++) {
      const product = await store.insertProduct({
        ulid: `01JP${String(i).padStart(22, '0')}`.toUpperCase(),
        name: `component ${i}`,
        shelf_life_class: 'pantry',
        aliases: [],
        nutrition_per_100g: null,
        ingredients: null,
        package_size: null,
        shelf_life_days_unopened: null,
        shelf_life_days_opened: null,
        net_content_g: 500,
      } as any);
      const { item } = await pipeline.createItem({
        product_ulid: product.ulid,
        acquired_at: '2026-07-01',
        on_hand_fraction: 1,
      });
      await pipeline.applyEvent(item.ulid, 'opened', { at: '2026-07-10' });
      items.push(item.ulid);
    }

    // The entry the sheet logs, journaled by the entries side as usual.
    const flagged: string[][] = [];
    const cook = new KitchenCookMode({
      entries: {
        async ingest(input) {
          const { record, created } = await entryStore.insertIfAbsent({
            ulid: input.ulid,
            logged_at: new Date('2026-07-17T12:00:00Z'),
            note: input.note ?? null,
            recipe_ulid: null,
            component_quantities: null,
            notes_reviewed: true,
          });
          return { record, created };
        },
        async flagUnappliedDecrements(_ulid, unapplied) {
          flagged.push(unapplied);
        },
      },
      inventory: fakeConverter().inventory,
      depleter: {
        consumeStated: (itemUlid, input) => pipeline.consumeStatedAmount(itemUlid, input),
        finishUnit: (itemUlid, input) => pipeline.applyEvent(itemUlid, 'finished-unit', input),
      },
    });

    return { cook, pipeline, store, entryStore, items, flagged };
  }

  it('applies all six decrements and flags none', async () => {
    const { cook, store, entryStore, items, flagged } = await realDepleterHarness(6);

    await cook.cook(
      request({
        ulid: KEY,
        components: items.map((_, i) => ({ label: `c${i}`, quantity: 50 })),
        consumes: items.map((ulid, i) => ({
          component: `c${i}`,
          item_ulid: ulid,
          model: 'divisible' as const,
        })),
        at: '2026-07-17',
      }) as any
    );

    expect(flagged).toEqual([]);
    // 50 g off a 500 g basis = 0.1 of the package, on every one of the six.
    for (const ulid of items) {
      expect(store.items.get(ulid)!.on_hand_fraction).toBeCloseTo(0.9, 6);
    }
    const rows = await entryStore.listConsumptions(KEY);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.item_ulid).sort()).toEqual([...items].sort());
  });

  it('a retried binding re-applies nothing — the guard is per (entry, item), not per entry', async () => {
    const { cook, pipeline, store, entryStore, items } = await realDepleterHarness(3);
    const sheet = request({
      ulid: KEY,
      components: items.map((_, i) => ({ label: `c${i}`, quantity: 50 })),
      consumes: items.map((ulid, i) => ({
        component: `c${i}`,
        item_ulid: ulid,
        model: 'divisible' as const,
      })),
      at: '2026-07-17',
    }) as any;

    await cook.cook(sheet);

    // A whole-sheet resubmission never reaches the bindings — the entry ingest
    // is ULID-idempotent and `logEaten` only decrements on a fresh entry.
    await cook.cook(sheet);

    // The case that DOES reach them: one binding retried on its own, the shape
    // a flaky network or a partially-failed run produces.
    const retry = await pipeline.consumeStatedAmount(items[1]!, {
      amount_g: 50,
      entry_ulid: KEY,
      at: '2026-07-17',
    });
    expect(retry!.linked).toBe(false);

    for (const ulid of items) {
      expect(store.items.get(ulid)!.on_hand_fraction).toBeCloseTo(0.9, 6);
    }
    expect(await entryStore.listConsumptions(KEY)).toHaveLength(3);
  });
});
