import { describe, it, expect } from 'bun:test';
import { KitchenCookMode } from './services/cook-mode.js';
import type { WorksheetCookRequest } from '@jarvus/claude-assist-core';

/**
 * A packed sheet's decrements must follow the weights the human actually
 * submitted, not the amounts frozen when the sheet was published
 * (specs/modules/kitchen.md § A packed batch's sources follow the submitted
 * weights).
 */

type ConvertCall = {
  sources?: { item_ulid: string; amount?: number; amount_g?: number }[];
};

/** Captures what `convert` was asked to do; the conversion itself is elsewhere's job. */
function makeCookMode() {
  const calls: ConvertCall[] = [];
  const cook = new KitchenCookMode({
    entries: {
      ingest: async () => ({ record: { ulid: 'x' }, created: true }),
    },
    inventory: {
      convert: async (input: ConvertCall) => {
        calls.push(input);
        return { derived: { ulid: 'derived' }, created: true };
      },
    },
  } as never);
  return { cook, calls };
}

function packedRequest(over: Partial<WorksheetCookRequest> = {}): WorksheetCookRequest {
  return {
    ulid: '01JQXY000000000000000000AA',
    disposition: 'packed',
    label: 'Batch',
    totals: { calories: 100 },
    components: [{ label: 'Farro (dry)', quantity: 220 }],
    unit: 'g',
    consumes: [{ component: 'Farro (dry)', item_ulid: 'ITEM_FARRO', model: 'divisible' }],
    packed: { units: 3 },
    ...over,
  } as WorksheetCookRequest;
}

describe('packed sources follow the submitted weights', () => {
  it('decrements the SUBMITTED quantity, not the published plan', async () => {
    const { cook, calls } = makeCookMode();
    // Published at 200 g; the cook actually poured 220 g and said so.
    await cook.cook(packedRequest({ packed: { units: 3, sources: [{ item_ulid: 'ITEM_FARRO', amount: 0.2205 }] } }));

    expect(calls[0]!.sources).toEqual([{ item_ulid: 'ITEM_FARRO', amount_g: 220 }]);
  });

  it('lets a binding beat an explicit source for the same item, never applying both', async () => {
    const { cook, calls } = makeCookMode();
    await cook.cook(packedRequest({ packed: { units: 3, sources: [{ item_ulid: 'ITEM_FARRO', amount: 0.5 }] } }));

    // One entry for that item — a double-decrement here would look like success.
    expect(calls[0]!.sources).toHaveLength(1);
    expect(calls[0]!.sources![0]!.amount).toBeUndefined();
  });

  it('keeps an explicit source that binds to no component', async () => {
    const { cook, calls } = makeCookMode();
    await cook.cook(
      packedRequest({ packed: { units: 3, sources: [{ item_ulid: 'ITEM_OIL', amount: 0.05 }] } })
    );

    expect(calls[0]!.sources).toEqual([
      { item_ulid: 'ITEM_FARRO', amount_g: 220 },
      { item_ulid: 'ITEM_OIL', amount: 0.05 },
    ]);
  });

  it('multiplies by units ONLY when the sheet says its components are per-unit', async () => {
    const perUnit = makeCookMode();
    await perUnit.cook.cook(
      packedRequest({
        components: [{ label: 'Oats', quantity: 40 }],
        consumes: [{ component: 'Oats', item_ulid: 'ITEM_OATS', model: 'divisible' }],
        packed: { units: 3, components_per: 'unit' },
      })
    );
    expect(perUnit.calls[0]!.sources).toEqual([{ item_ulid: 'ITEM_OATS', amount_g: 120 }]);

    // The same sheet read as a whole-batch build decrements one jar's worth —
    // the under-decrement the declaration exists to prevent.
    const perBatch = makeCookMode();
    await perBatch.cook.cook(
      packedRequest({
        components: [{ label: 'Oats', quantity: 40 }],
        consumes: [{ component: 'Oats', item_ulid: 'ITEM_OATS', model: 'divisible' }],
        packed: { units: 3 },
      })
    );
    expect(perBatch.calls[0]!.sources).toEqual([{ item_ulid: 'ITEM_OATS', amount_g: 40 }]);
  });

  it('spends a counted source in whole units, never a fraction of one', async () => {
    const { cook, calls } = makeCookMode();
    await cook.cook(
      packedRequest({
        components: [{ label: 'Eggs', quantity: 4 }],
        consumes: [{ component: 'Eggs', item_ulid: 'ITEM_EGGS', model: 'counted' }],
        packed: { units: 4 },
      })
    );

    expect(calls[0]!.sources).toEqual([{ item_ulid: 'ITEM_EGGS', amount: 4 }]);
  });

  it('skips a binding with no submitted quantity rather than falling back to the plan', async () => {
    const { cook, calls } = makeCookMode();
    await cook.cook(
      packedRequest({
        components: [{ label: 'Something else', quantity: 100 }],
        packed: { units: 3 },
      })
    );

    // The published amount is precisely the stale number this resolution exists
    // to stop trusting, so an unresolvable binding decrements nothing.
    expect(calls[0]!.sources).toBeUndefined();
  });

  it('treats a zero quantity as nothing spent', async () => {
    const { cook, calls } = makeCookMode();
    await cook.cook(packedRequest({ components: [{ label: 'Farro (dry)', quantity: 0 }] }));

    expect(calls[0]!.sources).toBeUndefined();
  });
});
