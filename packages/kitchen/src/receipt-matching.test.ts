import { describe, it, expect } from 'bun:test';
import { MemoryInventoryStore } from './inventory-memory-store.js';
import { InventoryPipeline } from './services/inventory.js';
import { generateUlid } from './ulid.js';

/**
 * specs/modules/kitchen.md § Receipt-line matching.
 *
 * Two defects this pins, both of which were silent in normal use: a resolution
 * that taught nothing, and a roster the parser never saw.
 */

function build() {
  const store = new MemoryInventoryStore();
  const parserCalls: any[] = [];
  const pipeline = new InventoryPipeline(
    store,
    { parse: async (input: any) => { parserCalls.push(input); return { store: null, lines: [], total_cents: null }; } } as any,
    { parse: async () => ({}) } as any,
    { info() {}, warn() {}, error() {}, debug() {} } as any,
    {}
  );
  return { store, pipeline, parserCalls };
}

describe('learning from every resolution', () => {
  it('teaches the lexicon when a product is attached via recount, not only via a label scan', async () => {
    const { store, pipeline } = build();
    const product = await store.insertProduct({
      ulid: generateUlid(), name: 'Store Brand Widget', shelf_life_class: 'pantry',
    } as any);
    const { item } = await pipeline.createItem({
      raw_label: 'SB WIDGET 16Z', store: 'Example Grocer', acquired_at: '2026-01-05', needs_info: true,
    });

    expect(await store.getLexicon('Example Grocer', 'SB WIDGET 16Z')).toBeNull();

    await pipeline.reconcileItem(item.ulid, { product_ulid: product.ulid });

    // Without this, an identical line on the next receipt is unmatched forever —
    // the exact failure that prompted the spec.
    const learned = await store.getLexicon('Example Grocer', 'SB WIDGET 16Z');
    expect(learned?.product_ulid).toBe(product.ulid);
  });

  it('retracts the claim when the product link is removed', async () => {
    const { store, pipeline } = build();
    const product = await store.insertProduct({
      ulid: generateUlid(), name: 'Store Brand Widget', shelf_life_class: 'pantry',
    } as any);
    const { item } = await pipeline.createItem({
      raw_label: 'SB WIDGET 16Z', store: 'Example Grocer', acquired_at: '2026-01-05', needs_info: true,
    });
    await pipeline.reconcileItem(item.ulid, { product_ulid: product.ulid });
    await pipeline.reconcileItem(item.ulid, { product_ulid: null });

    // The row survives (the lexicon is monotonic in intent) but no longer
    // asserts a link the item does not make.
    const after = await store.getLexicon('Example Grocer', 'SB WIDGET 16Z');
    expect(after?.product_ulid ?? null).toBeNull();
  });

  it('does not teach when a recount changes something other than the product', async () => {
    const { store, pipeline } = build();
    const { item } = await pipeline.createItem({
      raw_label: 'MYSTERY LINE', store: 'Example Grocer', acquired_at: '2026-01-05', needs_info: true,
    });
    await pipeline.reconcileItem(item.ulid, { on_hand_fraction: 0.5 });
    expect(await store.getLexicon('Example Grocer', 'MYSTERY LINE')).toBeNull();
  });
});

describe('the store roster reaches the parser', () => {
  it('passes every known store, from items and lexicon alike', async () => {
    const { store, pipeline, parserCalls } = build();
    await pipeline.createItem({ raw_label: 'X', store: 'Example Grocer', acquired_at: '2026-01-05' });
    await pipeline.createItem({ raw_label: 'Y', store: 'Corner Market', acquired_at: '2026-01-05' });

    const { parse } = await pipeline.ingestReceipt(
      { ulid: generateUlid(), store: 'EXAMPLE GROCER', purchased_at: '2026-02-01' } as any,
      [{ data: Buffer.from('x'), mimeType: 'image/jpeg' } as any]
    );
    await parse;

    const roster = parserCalls[0]?.knownStores ?? [];
    // Truncating the roster would make a match impossible to find and invite a
    // duplicate store — so the whole list goes, every time.
    expect(roster).toContain('Example Grocer');
    expect(roster).toContain('Corner Market');
  });
});

describe('store aliases and merging', () => {
  it('folds one spelling into another, moving lexicon rows and items', async () => {
    const { store, pipeline } = build();
    const product = await store.insertProduct({
      ulid: generateUlid(), name: 'Widget', shelf_life_class: 'pantry',
    } as any);
    await store.upsertLexicon({
      ulid: generateUlid(), store: 'EXAMPLE GROCER', line_text: 'SB WIDGET',
      product_ulid: product.ulid, package_size: null, shelf_life_class: null,
    });
    await pipeline.createItem({ raw_label: 'SB WIDGET', store: 'EXAMPLE GROCER', acquired_at: '2026-01-05' });

    const moved = await pipeline.mergeStores('EXAMPLE GROCER', 'Example Grocer');
    expect(moved).toEqual({ lexicon: 1, items: 1 });

    // The mapping now answers under the surviving spelling.
    expect((await store.getLexicon('Example Grocer', 'SB WIDGET'))?.product_ulid).toBe(product.ulid);
    // And the old string resolves onto the survivor, so a receipt printing it lands on one key.
    expect(await store.getStoreAlias('EXAMPLE GROCER')).toBe('Example Grocer');
  });

  it('keeps the target mapping when both spellings map the same line', async () => {
    const { store, pipeline } = build();
    const [a, b] = [await store.insertProduct({ ulid: generateUlid(), name: 'A' } as any),
                    await store.insertProduct({ ulid: generateUlid(), name: 'B' } as any)];
    await store.upsertLexicon({ ulid: generateUlid(), store: 'OLD', line_text: 'LINE', product_ulid: a.ulid } as any);
    await store.upsertLexicon({ ulid: generateUlid(), store: 'New', line_text: 'LINE', product_ulid: b.ulid } as any);

    await pipeline.mergeStores('OLD', 'New');
    // Re-keying must never clobber a mapping the target already asserts.
    expect((await store.getLexicon('New', 'LINE'))?.product_ulid).toBe(b.ulid);
    expect(await store.getLexicon('OLD', 'LINE')).toBeNull();
  });

  it('refuses nothing and does nothing when the two names are the same', async () => {
    const { pipeline } = build();
    expect(await pipeline.mergeStores('Same', 'Same')).toEqual({ lexicon: 0, items: 0 });
  });
});
