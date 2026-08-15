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
