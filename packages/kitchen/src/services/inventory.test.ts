import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { MemoryInventoryStore } from '../inventory-memory-store.js';
import type { MemoryInventoryStoreTestHooks } from '../inventory-memory-store.js';
import { MemoryEntryStore } from '../memory-store.js';
import { MemoryConsumeStore } from './consume-memory-store.js';
import {
  ConsumeIneligibleError,
  ConsumeNotConfiguredError,
  ConsumeValidationError,
  ConversionValidationError,
  InventoryPipeline,
  ItemConflictError,
  ItemValidationError,
  NotCountedItemError,
  ReconcileValidationError,
} from './inventory.js';
import { InvalidTransitionError } from '../inventory-state.js';
import type { ReceiptParser, ReceiptParseInput } from './receipt-parser.js';
import type { LabelParser, LabelParseInput } from './label-parser.js';
import type { InventoryPhotoPart, ParsedLabel, ParsedReceipt } from '../inventory-types.js';
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

class FakeReceiptParser implements ReceiptParser {
  constructor(private result: ParsedReceipt) {}
  async parse(_input: ReceiptParseInput): Promise<ParsedReceipt> {
    return this.result;
  }
}

class FakeLabelParser implements LabelParser {
  private result: ParsedLabel;
  constructor(result: Partial<ParsedLabel>) {
    this.result = {
      name: null,
      shelf_life_class: null,
      package_size: null,
      serving_size_g: null,
      servings_per_container: null,
      nutrition_per_serving: null,
      nutrition_per_100g: null,
      ingredients: null,
      unit_model_hint: null,
      net_content: null,
      aliases: [],
      ...result,
    };
  }
  async parse(_input: LabelParseInput): Promise<ParsedLabel> {
    return this.result;
  }
}

const photo: InventoryPhotoPart = { data: Buffer.from('img'), mimeType: 'image/jpeg' };
const ULID = (n: number) => `01J${String(n).padStart(23, '0')}`.toUpperCase();

describe('receipt intake', () => {
  it('posts a batch immediately; known lines match, unknown lines become needs_info questions', async () => {
    const store = new MemoryInventoryStore();
    // Seed a product + lexicon line for a known receipt line.
    const product = await store.insertProduct({
      ulid: ULID(1),
      name: 'Feta Cheese',
      shelf_life_class: 'fridge_short',
      aliases: ['feta'],
      nutrition_per_100g: null,
      ingredients: null,
      package_size: '8 oz',
      shelf_life_days_unopened: null,
      shelf_life_days_opened: null,
    });
    await store.upsertLexicon({
      ulid: ULID(2),
      store: 'Example Grocer',
      line_text: 'FETA CHEESE',
      product_ulid: product.ulid,
      package_size: '8 oz',
      shelf_life_class: 'fridge_short',
    });

    const parser = new FakeReceiptParser({
      store: 'Example Grocer',
      lines: [{ text: 'FETA CHEESE' }, { text: 'TOMATOESOR' }],
    });
    const pipeline = new InventoryPipeline(store, parser, null, log);

    const { batch, created } = await pipeline.ingestReceipt(
      { ulid: ULID(3), store: 'Example Grocer', purchased_at: '2026-07-18' },
      [photo]
    );
    expect(created).toBe(true);
    expect(batch.status).toBe('parsing');
    await pipeline.settle();

    const view = await pipeline.getBatchView(ULID(3));
    expect(view?.batch.status).toBe('parsed');
    expect(view?.lines.map((l) => l.match_outcome).sort()).toEqual(['matched', 'unmatched']);

    const onHand = await pipeline.listInventory({});
    expect(onHand.length).toBe(2);
    const matched = onHand.find((i) => i.product_ulid === product.ulid)!;
    expect(matched.acquired_at).toBe('2026-07-18');
    expect(matched.eat_by).toBe('2026-08-01'); // +14 days fridge_short
    expect(matched.needs_info).toBe(false);

    const questions = await pipeline.listQuestions();
    expect(questions.length).toBe(1);
    expect(questions[0]!.raw_label).toBe('TOMATOESOR');
  });

  it('with no parser configured, the batch stays parsing (no photos survive)', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { batch } = await pipeline.ingestReceipt({ ulid: ULID(4) }, [photo]);
    await pipeline.settle();
    expect(batch.status).toBe('parsing');
  });

  it('is idempotent on ULID replay', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, new FakeReceiptParser({ store: null, lines: [] }), null, log);
    const first = await pipeline.ingestReceipt({ ulid: ULID(5) }, [photo]);
    const second = await pipeline.ingestReceipt({ ulid: ULID(5) }, [photo]);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  it('stamps the header-extracted store onto the batch + items when no meta store is given', async () => {
    const store = new MemoryInventoryStore();
    const parser = new FakeReceiptParser({ store: 'Example Grocer', lines: [{ text: 'MYSTERY ITEM' }] });
    const pipeline = new InventoryPipeline(store, parser, null, log);
    // No `store` on the scan meta — the parser's header extraction fills it.
    await pipeline.ingestReceipt({ ulid: ULID(6), purchased_at: '2026-07-18' }, [photo]);
    await pipeline.settle();

    const view = await pipeline.getBatchView(ULID(6));
    expect(view!.batch.store).toBe('Example Grocer');
    expect(view!.batch.store_undetermined).toBe(false);
    const items = await pipeline.listInventory({});
    expect(items.every((i) => i.store === 'Example Grocer')).toBe(true);
  });

  it('an explicit meta store overrides the header extraction', async () => {
    const store = new MemoryInventoryStore();
    // The header says one thing; the owner named another on the scan meta.
    const parser = new FakeReceiptParser({ store: 'Header Extraction', lines: [{ text: 'MYSTERY ITEM' }] });
    const pipeline = new InventoryPipeline(store, parser, null, log);
    await pipeline.ingestReceipt({ ulid: ULID(7), store: 'Owner Named Store', purchased_at: '2026-07-18' }, [photo]);
    await pipeline.settle();

    const view = await pipeline.getBatchView(ULID(7));
    expect(view!.batch.store).toBe('Owner Named Store');
    expect(view!.batch.store_undetermined).toBe(false);
    const items = await pipeline.listInventory({});
    expect(items.every((i) => i.store === 'Owner Named Store')).toBe(true);
  });

  it('records store_undetermined when neither the meta nor the extraction yields a store', async () => {
    const store = new MemoryInventoryStore();
    const parser = new FakeReceiptParser({ store: null, lines: [{ text: 'MYSTERY ITEM' }] });
    const pipeline = new InventoryPipeline(store, parser, null, log);
    await pipeline.ingestReceipt({ ulid: ULID(8), purchased_at: '2026-07-18' }, [photo]);
    await pipeline.settle();

    const view = await pipeline.getBatchView(ULID(8));
    expect(view!.batch.store).toBeNull();
    expect(view!.batch.store_undetermined).toBe(true);
    // The batch still parsed and the unknown line still became a needs_info item.
    expect(view!.batch.status).toBe('parsed');
    const questions = await pipeline.listQuestions();
    expect(questions.length).toBe(1);
  });

  it('a multi-quantity line creates N items (one lifecycle each) + records the quantity on the line', async () => {
    const store = new MemoryInventoryStore();
    const parser = new FakeReceiptParser({
      store: 'Example Grocer',
      lines: [{ text: 'ITAL CHICKEN SAUSAGE', quantity: 3 }],
    });
    const pipeline = new InventoryPipeline(store, parser, null, log);
    await pipeline.ingestReceipt({ ulid: ULID(9), store: 'Example Grocer', purchased_at: '2026-07-18' }, [photo]);
    await pipeline.settle();

    const view = await pipeline.getBatchView(ULID(9));
    expect(view!.lines.length).toBe(1);
    expect(view!.lines[0]!.quantity).toBe(3);
    expect(view!.lines[0]!.match_outcome).toBe('unmatched');
    expect(view!.lines[0]!.inventory_item_ulid).not.toBeNull();

    // Three distinct physical units.
    const items = await pipeline.listInventory({});
    expect(items.length).toBe(3);
    expect(new Set(items.map((i) => i.ulid)).size).toBe(3);

    // But one deduped question carrying the count of 3.
    const questions = await pipeline.listQuestions();
    expect(questions.length).toBe(1);
    expect(questions[0]!.count).toBe(3);
    expect(questions[0]!.item_ulids.length).toBe(3);
  });

  it('a clearly non-food line is skipped (no item); an ambiguous line still becomes needs_info', async () => {
    const store = new MemoryInventoryStore();
    const parser = new FakeReceiptParser({
      store: 'Example Grocer',
      lines: [
        { text: 'PLASTIC FORKS', non_food: true },
        { text: 'MYSTERY ITEM' }, // ambiguous — no flag
      ],
    });
    const pipeline = new InventoryPipeline(store, parser, null, log);
    await pipeline.ingestReceipt({ ulid: ULID(12), store: 'Example Grocer', purchased_at: '2026-07-18' }, [photo]);
    await pipeline.settle();

    const view = await pipeline.getBatchView(ULID(12));
    const byText = Object.fromEntries(view!.lines.map((l) => [l.raw_text, l]));
    expect(byText['PLASTIC FORKS']!.match_outcome).toBe('skipped');
    expect(byText['PLASTIC FORKS']!.inventory_item_ulid).toBeNull();
    expect(byText['MYSTERY ITEM']!.match_outcome).toBe('unmatched');

    // Only the ambiguous line minted an item; the non-food line stocked nothing.
    const items = await pipeline.listInventory({});
    expect(items.length).toBe(1);
    expect(items[0]!.raw_label).toBe('MYSTERY ITEM');
    // The model judgment is per-receipt only — no durable lexicon marker written.
    expect(await store.getLexicon('Example Grocer', 'PLASTIC FORKS')).toBeNull();
  });

  it('a durable product mapping wins over a model non_food guess (still matched + stocked)', async () => {
    const store = new MemoryInventoryStore();
    const product = await store.insertProduct({
      ulid: ULID(13),
      name: 'Feta Cheese',
      shelf_life_class: 'fridge_short',
      aliases: [],
      nutrition_per_100g: null,
      ingredients: null,
      package_size: null,
      shelf_life_days_unopened: null,
      shelf_life_days_opened: null,
    });
    await store.upsertLexicon({
      ulid: ULID(14),
      store: 'Example Grocer',
      line_text: 'FETA CHEESE',
      product_ulid: product.ulid,
      package_size: null,
      shelf_life_class: 'fridge_short',
    });
    // Model wrongly guessed non_food, but the owner's lexicon mapping overrides.
    const parser = new FakeReceiptParser({
      store: 'Example Grocer',
      lines: [{ text: 'FETA CHEESE', non_food: true }],
    });
    const pipeline = new InventoryPipeline(store, parser, null, log);
    await pipeline.ingestReceipt({ ulid: ULID(15), store: 'Example Grocer', purchased_at: '2026-07-18' }, [photo]);
    await pipeline.settle();

    const view = await pipeline.getBatchView(ULID(15));
    expect(view!.lines[0]!.match_outcome).toBe('matched');
    const items = await pipeline.listInventory({});
    expect(items.length).toBe(1);
    expect(items[0]!.product_ulid).toBe(product.ulid);
    expect(items[0]!.needs_info).toBe(false);
  });

  it('a single-quantity line records quantity 1 (unchanged behavior)', async () => {
    const store = new MemoryInventoryStore();
    const parser = new FakeReceiptParser({ store: 'Example Grocer', lines: [{ text: 'MYSTERY ITEM' }] });
    const pipeline = new InventoryPipeline(store, parser, null, log);
    await pipeline.ingestReceipt({ ulid: ULID(16), store: 'Example Grocer', purchased_at: '2026-07-18' }, [photo]);
    await pipeline.settle();
    const view = await pipeline.getBatchView(ULID(16));
    expect(view!.lines[0]!.quantity).toBe(1);
    const items = await pipeline.listInventory({});
    expect(items.length).toBe(1);
  });
});

describe('label intake', () => {
  it('resolves a needs_info item, enriches the product, and writes the lexicon so the next receipt auto-resolves', async () => {
    const store = new MemoryInventoryStore();
    const parser = new FakeReceiptParser({ store: 'Example Grocer', lines: [{ text: 'TOMATOESOR' }] });
    const label = new FakeLabelParser({
      name: 'Roma Tomatoes',
      shelf_life_class: 'produce',
      package_size: '1 lb',
      nutrition_per_100g: { calories: 18, protein_g: 0.9, fat_g: 0.2, sat_fat_g: 0, carbs_g: 3.9, sodium_mg: 5, fiber_g: 1.2, sugar_g: 2.6 },
      ingredients: 'Tomatoes',
      aliases: ['tomatoes', 'roma'],
    });
    const pipeline = new InventoryPipeline(store, parser, label, log);

    await pipeline.ingestReceipt({ ulid: ULID(10), store: 'Example Grocer', purchased_at: '2026-07-18' }, [photo]);
    await pipeline.settle();
    const [q] = await pipeline.listQuestions();
    expect(q).toBeDefined();

    const resolved = await pipeline.resolveLabel(q!.item_ulid, [photo]);
    expect(resolved).not.toBeNull();
    expect(resolved!.product.name).toBe('Roma Tomatoes');
    expect(resolved!.item.needs_info).toBe(false);
    expect(resolved!.item.eat_by).toBe('2026-07-25'); // produce unopened +7 days from 07-18 (still stocked)
    // The full nutrition panel (incl. fiber/sugar) + ingredients bank onto the product.
    expect(resolved!.product.nutrition_per_100g!.fiber_g).toBe(1.2);
    expect(resolved!.product.nutrition_per_100g!.sugar_g).toBe(2.6);
    expect(resolved!.product.ingredients).toBe('Tomatoes');

    // A later receipt with the same line text now auto-resolves (no question).
    await pipeline.ingestReceipt({ ulid: ULID(11), store: 'Example Grocer', purchased_at: '2026-07-25' }, [photo]);
    await pipeline.settle();
    const questions = await pipeline.listQuestions();
    expect(questions.length).toBe(0);
    const items = await pipeline.listInventory({});
    // the new receipt's item is matched to the product
    expect(items.some((i) => i.acquired_at === '2026-07-25' && i.product_ulid === resolved!.product.ulid)).toBe(true);
  });
});

describe('lexicon retro-resolve (claude-assist#102)', () => {
  it('seeding a product mapping clears matching pending needs_info items immediately', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);

    const { item } = await pipeline.createItem({
      raw_label: 'ORG MILK 1GAL',
      store: 'Example Grocer',
      acquired_at: '2026-07-18',
      needs_info: true,
    });
    expect(item.needs_info).toBe(true);
    expect((await pipeline.listQuestions()).length).toBe(1);

    const product = await pipeline.createProduct({ name: 'Organic Whole Milk', shelf_life_class: 'fridge_short' });
    await pipeline.upsertLexicon({ store: 'Example Grocer', line_text: 'ORG MILK 1GAL', product_ulid: product.ulid });

    const resolved = await pipeline.getItemView(item.ulid);
    expect(resolved!.needs_info).toBe(false);
    expect(resolved!.product_ulid).toBe(product.ulid);
    expect(resolved!.shelf_life_class).toBe('fridge_short');
    expect(resolved!.eat_by).toBe('2026-08-01'); // fridge_short unopened +14d from 2026-07-18
    expect((await pipeline.listQuestions()).length).toBe(0);
  });

  it('lexicon line normalization matches case/whitespace variants of the raw label', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({
      raw_label: '  org   milk  1gal ',
      store: 'Example Grocer',
      acquired_at: '2026-07-18',
      needs_info: true,
    });
    const product = await pipeline.createProduct({ name: 'Organic Whole Milk', shelf_life_class: 'fridge_short' });
    await pipeline.upsertLexicon({ store: 'Example Grocer', line_text: 'ORG MILK 1GAL', product_ulid: product.ulid });
    expect((await pipeline.getItemView(item.ulid))!.needs_info).toBe(false);
  });

  it('leaves already-resolved, dismissed, and other-store items untouched', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);

    const otherProduct = await pipeline.createProduct({ name: 'Some Other Product' });
    const { item: alreadyResolved } = await pipeline.createItem({
      raw_label: 'ORG MILK 1GAL',
      store: 'Example Grocer',
      acquired_at: '2026-07-10',
      product_ulid: otherProduct.ulid,
      needs_info: false,
    });
    const { item: dismissed } = await pipeline.createItem({
      raw_label: 'ORG MILK 1GAL',
      store: 'Example Grocer',
      acquired_at: '2026-07-12',
      needs_info: true,
    });
    await pipeline.dismissItem(dismissed.ulid);
    const { item: otherStore } = await pipeline.createItem({
      raw_label: 'ORG MILK 1GAL',
      store: 'Different Store',
      acquired_at: '2026-07-14',
      needs_info: true,
    });
    const { item: pending } = await pipeline.createItem({
      raw_label: 'ORG MILK 1GAL',
      store: 'Example Grocer',
      acquired_at: '2026-07-18',
      needs_info: true,
    });

    const product = await pipeline.createProduct({ name: 'Organic Whole Milk', shelf_life_class: 'fridge_short' });
    await pipeline.upsertLexicon({ store: 'Example Grocer', line_text: 'ORG MILK 1GAL', product_ulid: product.ulid });

    // The genuinely-pending item resolved…
    expect((await pipeline.getItemView(pending.ulid))!.needs_info).toBe(false);
    expect((await pipeline.getItemView(pending.ulid))!.product_ulid).toBe(product.ulid);
    // …but nothing else moved.
    expect((await pipeline.getItemView(alreadyResolved.ulid))!.product_ulid).toBe(otherProduct.ulid);
    const dismissedView = await pipeline.getItemView(dismissed.ulid);
    expect(dismissedView!.state).toBe('dismissed');
    expect(dismissedView!.product_ulid).toBeNull();
    expect((await pipeline.getItemView(otherStore.ulid))!.needs_info).toBe(true);
  });

  it('a skip-marker upsert (non_inventory, no product) never retro-resolves anything', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({
      raw_label: 'SOUP MUG',
      store: 'Example Grocer',
      acquired_at: '2026-07-18',
      needs_info: true,
    });
    await store.upsertLexicon({
      ulid: 'skip-marker',
      store: 'Example Grocer',
      line_text: 'SOUP MUG',
      product_ulid: null,
      package_size: null,
      shelf_life_class: null,
      non_inventory: true,
    });
    expect((await pipeline.getItemView(item.ulid))!.needs_info).toBe(true);
  });

  it('future receipts still resolve after a retro-resolving lexicon seed (the queue never re-asks)', async () => {
    const store = new MemoryInventoryStore();
    const parser = new FakeReceiptParser({ store: 'Example Grocer', lines: [{ text: 'ORG MILK 1GAL' }] });
    const pipeline = new InventoryPipeline(store, parser, null, log);

    await pipeline.ingestReceipt({ ulid: ULID(20), store: 'Example Grocer', purchased_at: '2026-07-18' }, [photo]);
    await pipeline.settle();
    expect((await pipeline.listQuestions()).length).toBe(1);

    const product = await pipeline.createProduct({ name: 'Organic Whole Milk', shelf_life_class: 'fridge_short' });
    await pipeline.upsertLexicon({ store: 'Example Grocer', line_text: 'ORG MILK 1GAL', product_ulid: product.ulid });
    expect((await pipeline.listQuestions()).length).toBe(0);

    // A second receipt carrying the same line resolves straight to `matched` —
    // no new needs_info item, no new question.
    await pipeline.ingestReceipt({ ulid: ULID(21), store: 'Example Grocer', purchased_at: '2026-07-25' }, [photo]);
    await pipeline.settle();
    expect((await pipeline.listQuestions()).length).toBe(0);
    const items = await pipeline.listInventory({});
    expect(items.some((i) => i.acquired_at === '2026-07-25' && i.product_ulid === product.ulid)).toBe(true);
  });
});

describe('item events', () => {
  it('opening stamps opened_at + re-derives eat-by; finishing zeroes the fraction', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({
      raw_label: 'Soymilk',
      shelf_life_class: 'fridge_short',
      acquired_at: '2026-07-01',
    });
    expect(item.state).toBe('stocked');

    const opened = await pipeline.applyEvent(item.ulid, 'opened', { at: '2026-07-10' });
    expect(opened!.state).toBe('open');
    expect(opened!.opened_at).toBe('2026-07-10');
    expect(opened!.eat_by).toBe('2026-07-17'); // opened window 7 days

    const finished = await pipeline.applyEvent(item.ulid, 'finished', { at: '2026-07-15' });
    expect(finished!.state).toBe('finished');
    expect(finished!.on_hand_fraction).toBe(0);
    expect(finished!.closed_at).toBe('2026-07-15');
  });
});

describe('free-text event resolver', () => {
  it('matches the best open/stocked item and applies the state change', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const feta = await store.insertProduct({
      ulid: ULID(20), name: 'Feta Cheese', shelf_life_class: 'fridge_long', aliases: ['feta'],
      nutrition_per_100g: null, ingredients: null, package_size: null, shelf_life_days_unopened: null, shelf_life_days_opened: null,
    });
    await pipeline.createItem({ product_ulid: feta.ulid, shelf_life_class: 'fridge_long', acquired_at: '2026-07-01' });
    await pipeline.createItem({ raw_label: 'Tomatoes', shelf_life_class: 'produce', acquired_at: '2026-07-01' });

    const opened = await pipeline.resolveRemark('opened the feta');
    expect(opened.matched).toBe(true);
    expect(opened.event?.type).toBe('opened');
    expect(opened.item?.state).toBe('open');

    const tossed = await pipeline.resolveRemark('tossed half the tomatoes');
    expect(tossed.matched).toBe(true);
    expect(tossed.event?.type).toBe('tossed');
    expect(tossed.item?.on_hand_fraction).toBeCloseTo(0.5, 5);
    expect(tossed.item?.state).toBe('stocked'); // partial toss doesn't terminate
    expect(tossed.item?.notes).toContain('tossed 0.5'); // waste amount recorded

    const nothing = await pipeline.resolveRemark('opened the caviar');
    expect(nothing.matched).toBe(false);
  });
});

describe('depletion matcher', () => {
  it('decrements a plausibly matched on-hand item and links the entry; a non-match is a no-op', async () => {
    const store = new MemoryInventoryStore();
    const linked: Array<[string, string]> = [];
    const pipeline = new InventoryPipeline(store, null, null, log, {
      depletionStep: 0.34,
      linkEntry: async (e, i) => {
        linked.push([e, i]);
      },
    });
    const yog = await store.insertProduct({
      ulid: ULID(30), name: 'Greek Yogurt', shelf_life_class: 'fridge_short', aliases: ['yogurt'],
      nutrition_per_100g: null, ingredients: null, package_size: null, shelf_life_days_unopened: null, shelf_life_days_opened: null,
    });
    const { item } = await pipeline.createItem({ product_ulid: yog.ulid, shelf_life_class: 'fridge_short', acquired_at: '2026-07-15' });

    const depleted = await pipeline.matchAndDeplete({ ulid: ULID(31), label: 'Greek Yogurt with honey', status: 'estimated' });
    expect(depleted).not.toBeNull();
    expect(depleted!.on_hand_fraction).toBeCloseTo(0.66, 2);
    expect(linked).toEqual([[ULID(31), item.ulid]]);

    const noMatch = await pipeline.matchAndDeplete({ ulid: ULID(32), label: 'Pepperoni Pizza', status: 'estimated' });
    expect(noMatch).toBeNull();
    expect(linked.length).toBe(1);
  });

  it('decrements a COUNTED match by one whole sealed unit, not its meaningless fraction', async () => {
    const store = new MemoryInventoryStore();
    const linked: Array<[string, string]> = [];
    const pipeline = new InventoryPipeline(store, null, null, log, {
      depletionStep: 0.34,
      linkEntry: async (e, i) => {
        linked.push([e, i]);
      },
    });
    // A sealed multipack: counted, and OPENED (so the opened clock is running).
    const { item } = await pipeline.createItem({
      raw_label: 'Sparkling Water 9-pack',
      shelf_life_class: 'pantry',
      acquired_at: '2026-07-01',
      units_total: 9,
      state: 'open',
    });
    expect(item.units_remaining).toBe(9);

    const first = await pipeline.matchAndDeplete({ ulid: ULID(40), label: 'sparkling water', status: 'estimated' });
    expect(first).not.toBeNull();
    // The whole point: the COUNT moved.
    expect(first!.units_remaining).toBe(8);
    // …and the wire fraction FOLLOWED it, because a counted item derives the
    // fraction from the count (§ count-vs-fraction) rather than carrying an
    // independent stored one that would still read 1.0 with 8 of 9 left.
    expect(first!.on_hand_fraction).toBeCloseTo(8 / 9, 10);
    // finished-unit semantics: back to sealed, on the unopened clock.
    expect(first!.state).toBe('stocked');
    expect(first!.opened_at).toBeNull();
    expect(linked).toEqual([[ULID(40), item.ulid]]);

    // Seven further matched entries walk it down to one — the observed drift
    // was exactly this many logged consumptions against an untouched count.
    for (let n = 0; n < 7; n++) {
      await pipeline.matchAndDeplete({ ulid: ULID(41 + n), label: 'sparkling water', status: 'estimated' });
    }
    const nearlyGone = await pipeline.getItemView(item.ulid);
    expect(nearlyGone!.units_remaining).toBe(1);
    expect(nearlyGone!.state).toBe('stocked');

    // The last unit closes the item out, same as a whole-item finish.
    const last = await pipeline.matchAndDeplete({ ulid: ULID(48), label: 'sparkling water', status: 'estimated' });
    expect(last!.units_remaining).toBe(0);
    expect(last!.state).toBe('finished');
    expect(last!.on_hand_fraction).toBe(0);
    expect(last!.closed_at).not.toBeNull();

    // Terminal now, so it is out of the on-hand pool: a further entry matches
    // nothing and depletes nothing (no negative counts).
    const after = await pipeline.matchAndDeplete({ ulid: ULID(49), label: 'sparkling water', status: 'estimated' });
    expect(after).toBeNull();
  });

  it('skips an entry that already depleted an item — a re-estimate takes no second unit', async () => {
    const store = new MemoryInventoryStore();
    const linked: Array<[string, string]> = [];
    const pipeline = new InventoryPipeline(store, null, null, log, {
      linkEntry: async (e, i) => {
        linked.push([e, i]);
      },
    });
    const { item } = await pipeline.createItem({
      raw_label: 'Yogurt Cups 4-pack',
      shelf_life_class: 'fridge_short',
      acquired_at: '2026-07-20',
      units_total: 4,
    });

    const first = await pipeline.matchAndDeplete({ ulid: ULID(50), label: 'yogurt cups', status: 'estimated' });
    expect(first!.units_remaining).toBe(3);

    // The same entry reaching `estimated` again (note/label PATCH re-queue, or a
    // retried hook) now carries the link — the matcher must no-op.
    const replay = await pipeline.matchAndDeplete({
      ulid: ULID(50),
      label: 'yogurt cups',
      status: 'estimated',
      inventory_item_ulid: item.ulid,
    });
    expect(replay).toBeNull();
    expect((await pipeline.getItemView(item.ulid))!.units_remaining).toBe(3);
    expect(linked).toEqual([[ULID(50), item.ulid]]);
  });

  it('guards a fraction item the same way (the link is the key, not the unit model)', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log, { depletionStep: 0.34 });
    const { item } = await pipeline.createItem({
      raw_label: 'Oat Milk',
      shelf_life_class: 'fridge_short',
      acquired_at: '2026-07-20',
    });

    await pipeline.matchAndDeplete({ ulid: ULID(60), label: 'oat milk', status: 'estimated' });
    expect((await pipeline.getItemView(item.ulid))!.on_hand_fraction).toBeCloseTo(0.66, 2);

    await pipeline.matchAndDeplete({
      ulid: ULID(60),
      label: 'oat milk',
      status: 'estimated',
      inventory_item_ulid: item.ulid,
    });
    expect((await pipeline.getItemView(item.ulid))!.on_hand_fraction).toBeCloseTo(0.66, 2);
  });
});

describe('grouped questions', () => {
  it('deduplicates needs_info questions by (store, line_text), carrying the count + covered ulids', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    // A ×2 line: two physical units, same store + label.
    await pipeline.createItem({ raw_label: 'ITAL CHICKEN SAUSAGE', store: 'Example Grocer', acquired_at: '2026-07-18', needs_info: true });
    await pipeline.createItem({ raw_label: 'ital chicken sausage', store: 'Example Grocer', acquired_at: '2026-07-19', needs_info: true });
    // A distinct single line.
    await pipeline.createItem({ raw_label: 'MYSTERY JAR', store: 'Example Grocer', acquired_at: '2026-07-18', needs_info: true });

    const questions = await pipeline.listQuestions();
    expect(questions.length).toBe(2); // two lines, not three items
    const sausage = questions.find((q) => q.raw_label === 'ITAL CHICKEN SAUSAGE')!;
    expect(sausage.count).toBe(2);
    expect(sausage.item_ulids.length).toBe(2);
    expect(sausage.acquired_at).toBe('2026-07-18'); // earliest
    expect(sausage.question).toContain('×2');
    const jar = questions.find((q) => q.raw_label === 'MYSTERY JAR')!;
    expect(jar.count).toBe(1);
    expect(jar.question).not.toContain('×');
  });

  it('never groups null-raw_label items together', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    await pipeline.createItem({ store: 'S', acquired_at: '2026-07-18', needs_info: true });
    await pipeline.createItem({ store: 'S', acquired_at: '2026-07-19', needs_info: true });
    const questions = await pipeline.listQuestions();
    expect(questions.length).toBe(2);
    expect(questions.every((q) => q.count === 1)).toBe(true);
  });
});

describe('label fan-out', () => {
  it('resolving one item resolves every same-line needs_info sibling, each with its own eat-by', async () => {
    const store = new MemoryInventoryStore();
    const label = new FakeLabelParser({
      name: 'Italian Chicken Sausage', shelf_life_class: 'fridge_short', package_size: '12 oz',
      nutrition_per_100g: null, ingredients: null, aliases: ['chicken sausage'],
    });
    const pipeline = new InventoryPipeline(store, null, label, log);
    // Two units of the same line, acquired on different days.
    const a = await pipeline.createItem({ raw_label: 'ITAL CHICKEN SAUSAGE', store: 'Example Grocer', acquired_at: '2026-07-18', needs_info: true });
    const b = await pipeline.createItem({ raw_label: 'ITAL CHICKEN SAUSAGE', store: 'Example Grocer', acquired_at: '2026-07-20', needs_info: true });

    const resolved = await pipeline.resolveLabel(a.item.ulid, [photo]);
    expect(resolved).not.toBeNull();
    expect(resolved!.resolved_count).toBe(2); // scanned + one sibling
    expect(resolved!.item.eat_by).toBe('2026-08-01'); // 07-18 + 14 fridge_short

    // The sibling is resolved to the same product, its OWN eat-by re-derived.
    const sib = await pipeline.getItemView(b.item.ulid);
    expect(sib!.needs_info).toBe(false);
    expect(sib!.product_ulid).toBe(resolved!.product.ulid);
    expect(sib!.eat_by).toBe('2026-08-03'); // 07-20 + 14, distinct from the scanned unit
    // No more open questions for that line.
    const questions = await pipeline.listQuestions();
    expect(questions.length).toBe(0);
  });

  it('a single needs_info item with no siblings resolves with resolved_count 1', async () => {
    const store = new MemoryInventoryStore();
    const label = new FakeLabelParser({ name: 'Feta', shelf_life_class: 'fridge_long', package_size: null, nutrition_per_100g: null, ingredients: null, aliases: [] });
    const pipeline = new InventoryPipeline(store, null, label, log);
    const a = await pipeline.createItem({ raw_label: 'FETA', store: 'S', acquired_at: '2026-07-18', needs_info: true });
    const resolved = await pipeline.resolveLabel(a.item.ulid, [photo]);
    expect(resolved!.resolved_count).toBe(1);
  });
});

describe('label enrichment (ingredients + full panel + precedence)', () => {
  const mkLabel = (over: Partial<ParsedLabel>): ParsedLabel => ({
    name: 'Store Feta',
    shelf_life_class: 'fridge_long',
    package_size: null,
    serving_size_g: null,
    servings_per_container: null,
    nutrition_per_serving: null,
    nutrition_per_100g: null,
    ingredients: null,
    unit_model_hint: null,
    net_content: null,
    aliases: [],
    ...over,
  });

  it('a later scan merges nutrition per-field and never null-clobbers ingredients', async () => {
    const store = new MemoryInventoryStore();
    // First scan reads calories/protein + the ingredients list.
    const first = new FakeLabelParser(
      mkLabel({
        nutrition_per_100g: { calories: 264, protein_g: 14, fat_g: 21, sat_fat_g: 15, carbs_g: 4, sodium_mg: 900 },
        ingredients: 'Cultured pasteurized milk, salt, enzymes',
      })
    );
    const pipeline1 = new InventoryPipeline(store, null, first, log);
    const a = await pipeline1.createItem({ raw_label: 'FETA', store: 'S', acquired_at: '2026-07-18', needs_info: true });
    const r1 = await pipeline1.resolveLabel(a.item.ulid, [photo]);
    const productUlid = r1!.product.ulid;
    expect(r1!.product.nutrition_per_100g!.calories).toBe(264);
    expect(r1!.product.nutrition_per_100g!.fiber_g).toBeNull();
    expect(r1!.product.ingredients).toBe('Cultured pasteurized milk, salt, enzymes');

    // Second scan (already-linked item) reads ONLY fiber/sugar and no ingredients.
    const second = new FakeLabelParser(
      mkLabel({
        nutrition_per_100g: { calories: null, protein_g: null, fat_g: null, sat_fat_g: null, carbs_g: null, sodium_mg: null, fiber_g: 0, sugar_g: 3 },
        ingredients: null,
      })
    );
    const pipeline2 = new InventoryPipeline(store, null, second, log);
    const r2 = await pipeline2.resolveLabel(a.item.ulid, [photo]);
    // Enrich path: same linked product, item untouched.
    expect(r2!.product.ulid).toBe(productUlid);
    expect(r2!.resolved_count).toBe(1);
    expect(r2!.item.state).toBe('stocked');
    expect(r2!.item.needs_info).toBe(false);
    // Per-field merge: earlier calories survive, new fiber/sugar fill in.
    expect(r2!.product.nutrition_per_100g!.calories).toBe(264); // not erased
    expect(r2!.product.nutrition_per_100g!.protein_g).toBe(14);
    expect(r2!.product.nutrition_per_100g!.fiber_g).toBe(0);
    expect(r2!.product.nutrition_per_100g!.sugar_g).toBe(3);
    // Null incoming ingredients does not clobber the earlier list.
    expect(r2!.product.ingredients).toBe('Cultured pasteurized milk, salt, enzymes');
  });

  it('enriches an already-linked stocked item: product updated, state untouched, lexicon written', async () => {
    const store = new MemoryInventoryStore();
    const label = new FakeLabelParser(mkLabel({ name: 'Store Feta', ingredients: 'Milk, salt' }));
    const pipeline = new InventoryPipeline(store, null, label, log);
    // A directly-stocked (already resolved, product-linked) item — no needs_info.
    const product = await store.insertProduct({
      ulid: ULID(50), name: 'Store Feta', shelf_life_class: 'fridge_long', aliases: [],
      nutrition_per_100g: null, ingredients: null, package_size: null, shelf_life_days_unopened: null, shelf_life_days_opened: null,
    });
    const { item } = await pipeline.createItem({
      product_ulid: product.ulid, raw_label: 'FETA BLOCK', store: 'S',
      shelf_life_class: 'fridge_long', acquired_at: '2026-07-18',
    });
    expect(item.needs_info).toBe(false);

    const res = await pipeline.resolveLabel(item.ulid, [photo]);
    expect(res!.product.ulid).toBe(product.ulid); // enriched the linked product, no new one
    expect(res!.product.ingredients).toBe('Milk, salt');
    // Item state untouched.
    const after = await pipeline.getItemView(item.ulid);
    expect(after!.state).toBe('stocked');
    expect(after!.eat_by).toBe(item.eat_by);
    // Lexicon line written for future receipts.
    const lex = await store.getLexicon('S', 'FETA BLOCK');
    expect(lex!.product_ulid).toBe(product.ulid);
    // No new product created.
    expect((await store.listProducts({})).length).toBe(1);
  });

  it('rejects a label scan on a terminal item (→ 409 at the route)', async () => {
    const store = new MemoryInventoryStore();
    const label = new FakeLabelParser(mkLabel({}));
    const pipeline = new InventoryPipeline(store, null, label, log);
    const { item } = await pipeline.createItem({ raw_label: 'X', acquired_at: '2026-07-18' });
    await pipeline.applyEvent(item.ulid, 'finished', { at: '2026-07-18' });
    expect(pipeline.resolveLabel(item.ulid, [photo])).rejects.toThrow();
  });
});

describe('non-inventory dismissal', () => {
  it('dismisses a single item to a terminal non-waste state, excluded from lists + questions', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({ raw_label: 'SOUP MUG', store: 'Example Grocer', acquired_at: '2026-07-18', needs_info: true });

    const res = await pipeline.dismissItem(item.ulid, { at: '2026-07-19' });
    expect(res).not.toBeNull();
    expect(res!.dismissed_count).toBe(1);
    expect(res!.non_inventory).toBe(false);
    expect(res!.item.state).toBe('dismissed');
    expect(res!.item.closed_at).toBe('2026-07-19');
    // NOT a food-waste event: no toss note, fraction untouched.
    expect(res!.item.on_hand_fraction).toBe(1);
    expect(res!.item.notes ?? '').not.toContain('tossed');

    // Gone from the default on-hand list and the questions queue.
    expect((await pipeline.listInventory({})).some((i) => i.ulid === item.ulid)).toBe(false);
    expect((await pipeline.listQuestions()).length).toBe(0);
    // Still inspectable when explicitly asking for the dismissed state.
    const dismissed = await pipeline.listInventory({ states: ['dismissed'] });
    expect(dismissed.some((i) => i.ulid === item.ulid)).toBe(true);
  });

  it('dismissing a terminal item throws (→ 409 at the route)', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({ raw_label: 'X', acquired_at: '2026-07-18' });
    await pipeline.applyEvent(item.ulid, 'finished', { at: '2026-07-18' });
    expect(pipeline.dismissItem(item.ulid)).rejects.toThrow();
  });

  it('non_inventory flag: fans out to same-line siblings, writes a skip marker, next receipt skips the line', async () => {
    const store = new MemoryInventoryStore();
    const parser = new FakeReceiptParser({ store: 'Example Grocer', lines: [{ text: 'SOUP MUG' }] });
    const pipeline = new InventoryPipeline(store, parser, null, log);
    const a = await pipeline.createItem({ raw_label: 'SOUP MUG', store: 'Example Grocer', acquired_at: '2026-07-18', needs_info: true });
    const b = await pipeline.createItem({ raw_label: 'soup mug', store: 'Example Grocer', acquired_at: '2026-07-19', needs_info: true });

    const res = await pipeline.dismissItem(a.item.ulid, { nonInventory: true });
    expect(res!.non_inventory).toBe(true);
    expect(res!.dismissed_count).toBe(2);

    // Sibling was dismissed too.
    expect((await pipeline.getItemView(b.item.ulid))!.state).toBe('dismissed');
    // Skip marker written.
    const lex = await store.getLexicon('Example Grocer', 'SOUP MUG');
    expect(lex!.non_inventory).toBe(true);
    expect(lex!.product_ulid).toBeNull();

    // A future receipt with that line is recorded skipped, no item created.
    const before = (await pipeline.listInventory({ states: ['stocked', 'open'] })).length;
    await pipeline.ingestReceipt({ ulid: ULID(40), store: 'Example Grocer', purchased_at: '2026-07-25' }, [photo]);
    await pipeline.settle();
    const view = await pipeline.getBatchView(ULID(40));
    expect(view!.lines.length).toBe(1);
    expect(view!.lines[0]!.match_outcome).toBe('skipped');
    expect(view!.lines[0]!.inventory_item_ulid).toBeNull();
    const after = (await pipeline.listInventory({ states: ['stocked', 'open'] })).length;
    expect(after).toBe(before); // no new stocked item
  });

  it('single-item dismissal (no flag) leaves siblings + future receipts unaffected', async () => {
    const store = new MemoryInventoryStore();
    const parser = new FakeReceiptParser({ store: 'Example Grocer', lines: [{ text: 'SOUP MUG' }] });
    const pipeline = new InventoryPipeline(store, parser, null, log);
    const a = await pipeline.createItem({ raw_label: 'SOUP MUG', store: 'Example Grocer', acquired_at: '2026-07-18', needs_info: true });
    const b = await pipeline.createItem({ raw_label: 'SOUP MUG', store: 'Example Grocer', acquired_at: '2026-07-19', needs_info: true });

    const res = await pipeline.dismissItem(a.item.ulid); // no flag
    expect(res!.dismissed_count).toBe(1);
    expect(res!.non_inventory).toBe(false);
    // Sibling still needs_info; still surfaces as a question (count 1 now).
    expect((await pipeline.getItemView(b.item.ulid))!.needs_info).toBe(true);
    const questions = await pipeline.listQuestions();
    expect(questions.length).toBe(1);
    expect(questions[0]!.count).toBe(1);
    // No skip marker → a future receipt still lands a needs_info item.
    await pipeline.ingestReceipt({ ulid: ULID(41), store: 'Example Grocer', purchased_at: '2026-07-25' }, [photo]);
    await pipeline.settle();
    const view = await pipeline.getBatchView(ULID(41));
    expect(view!.lines[0]!.match_outcome).toBe('unmatched');
    expect(view!.lines[0]!.inventory_item_ulid).not.toBeNull();
  });
});

describe('item merge (§ Item corrections)', () => {
  /**
   * A pipeline wired the way the module wires it, so the entries relink crosses
   * the same store seam the depletion matcher's `linkEntry` does.
   */
  function harness() {
    const store = new MemoryInventoryStore();
    const entries = new MemoryEntryStore();
    const pipeline = new InventoryPipeline(store, null, null, log, {
      consumeStore: new MemoryConsumeStore(entries, store),
      resolveRecipe: async () => null,
      linkEntry: (entryUlid, itemUlid) => entries.linkInventoryItem(entryUlid, itemUlid),
      relinkEntries: (from, to) => entries.relinkInventoryItem(from, to),
    });
    return { store, entries, pipeline };
  }

  it('relinks each real dependent onto the survivor and retires the loser as dismissed', async () => {
    const { store, entries, pipeline } = harness();
    const product = await store.insertProduct({
      ulid: ULID(70), name: 'Rolled Oats', shelf_life_class: 'pantry', aliases: [],
      nutrition_per_100g: null, ingredients: null, package_size: null,
      shelf_life_days_unopened: null, shelf_life_days_opened: null,
    });
    const { item: survivor } = await pipeline.createItem({ product_ulid: product.ulid, acquired_at: '2026-07-01' });
    const { item: loser } = await pipeline.createItem({ product_ulid: product.ulid, acquired_at: '2026-07-02' });

    // Dependent 1 — a consumption entry that depleted the loser.
    const { record: entry } = await entries.insertIfAbsent({
      ulid: ULID(71), logged_at: new Date('2026-07-03T12:00:00Z'), note: 'oatmeal',
      recipe_ulid: null, component_quantities: null,
    });
    await entries.linkInventoryItem(entry.ulid, loser.ulid);

    // Dependent 2 — the receipt line whose representative unit the loser was.
    const batch = await store.insertBatchIfAbsent({ ulid: ULID(72), source: 'receipt', store: 'Example Grocer', purchased_at: new Date('2026-07-02') });
    const line = await store.insertLine({
      ulid: ULID(73), batch_ulid: batch.record.ulid, raw_text: 'ROLLED OATS',
      match_outcome: 'matched', product_ulid: product.ulid, inventory_item_ulid: loser.ulid,
    });

    // Dependent 3 — a conversion that SPENT the loser as an input.
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: loser.ulid, amount: 0.5 }],
      derived: { name: 'Overnight oats jar', units_total: 2 },
      at: '2026-07-03',
    });

    const result = await pipeline.mergeItems(loser.ulid, survivor.ulid);
    expect(result).not.toBeNull();
    expect(result!.relinked).toEqual({ entries: 1, batch_lines: 1, derivations: 0, derivation_sources: 1 });

    expect((await entries.get(entry.ulid))!.inventory_item_ulid).toBe(survivor.ulid);
    expect((await store.listLines(batch.record.ulid)).find((l) => l.ulid === line.ulid)!.inventory_item_ulid).toBe(survivor.ulid);
    const derivation = (await store.getDerivationsByDerivedItemUlids([derived.ulid])).get(derived.ulid)!;
    expect(derivation.sources.map((s) => s.item_ulid)).toEqual([survivor.ulid]);

    // The loser is retired as dismissed — no consumption, no waste — with a
    // forward pointer, and is off every on-hand listing.
    expect(result!.merged.state).toBe('dismissed');
    expect(result!.merged.merged_into).toBe(survivor.ulid);
    expect(result!.merged.notes ?? '').not.toContain('tossed');
    const onHand = (await pipeline.listInventory({})).map((i) => i.ulid);
    expect(onHand).toContain(survivor.ulid);
    expect(onHand).not.toContain(loser.ulid);
  });

  it("moves the loser's derivation only when the survivor has none", async () => {
    const { store, pipeline } = harness();
    const { item: oats } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });

    // Survivor is a plain item, loser is a made (derived) one: its provenance —
    // which is what makes an item consume-eligible — moves across.
    const { item: survivor } = await pipeline.createItem({ raw_label: 'Oat jar', acquired_at: '2026-07-03' });
    const { derived: loser } = await pipeline.convert({
      sources: [{ item_ulid: oats.ulid, amount: 0.25 }],
      derived: { name: 'Overnight oats jar' },
      at: '2026-07-03',
    });
    const first = await pipeline.mergeItems(loser.ulid, survivor.ulid);
    expect(first!.relinked.derivations).toBe(1);
    expect((await pipeline.getItemView(survivor.ulid))!.derived_from).not.toBeNull();

    // Now the survivor carries provenance of its own: derived_item_ulid is 1:1,
    // so a second loser's stays with the loser rather than one being dropped.
    const { derived: second } = await pipeline.convert({
      sources: [{ item_ulid: oats.ulid, amount: 0.25 }],
      derived: { name: 'Overnight oats jar' },
      at: '2026-07-04',
    });
    const again = await pipeline.mergeItems(second.ulid, survivor.ulid);
    expect(again!.relinked.derivations).toBe(0);
    expect((await store.getDerivationsByDerivedItemUlids([second.ulid])).has(second.ulid)).toBe(true);
  });

  it('fills only the survivor’s empty identity fields, re-derives eat_by on its OWN clock, and never sums quantities', async () => {
    const { store, pipeline } = harness();
    const product = await store.insertProduct({
      ulid: ULID(74), name: 'Grape Tomatoes', shelf_life_class: 'produce', aliases: [],
      nutrition_per_100g: null, ingredients: null, package_size: null,
      shelf_life_days_unopened: null, shelf_life_days_opened: null,
    });
    const { item: survivor } = await pipeline.createItem({
      raw_label: 'GRAPE TOMATO PINT', store: 'Example Grocer', acquired_at: '2026-07-18',
      on_hand_fraction: 0.5, needs_info: true,
    });
    const { item: loser } = await pipeline.createItem({
      product_ulid: product.ulid, raw_label: 'New item', store: 'Other Grocer', acquired_at: '2026-07-19',
    });

    const result = await pipeline.mergeItems(loser.ulid, survivor.ulid);
    const merged = result!.item;
    // Gap filled: the identity the loser carried.
    expect(merged.product_ulid).toBe(product.ulid);
    expect(merged.needs_info).toBe(false);
    expect(merged.shelf_life_class).toBe('produce');
    // NOT overwritten: the survivor's own label and store win.
    expect(merged.raw_label).toBe('GRAPE TOMATO PINT');
    expect(merged.store).toBe('Example Grocer');
    // The survivor's own clock, not the loser's day-later one (7/18 + 7d).
    expect(merged.acquired_at).toBe('2026-07-18');
    expect(merged.eat_by).toBe('2026-07-25');
    // Two records were ONE package: quantities are never added.
    expect(merged.on_hand_fraction).toBe(0.5);
  });

  it('merges an already-terminal loser, retracting a finished that was only a workaround', async () => {
    const { pipeline } = harness();
    const { item: survivor } = await pipeline.createItem({ raw_label: 'Tomatoes', acquired_at: '2026-07-18' });
    const { item: loser } = await pipeline.createItem({ raw_label: 'Tomatoes', acquired_at: '2026-07-19' });
    // The pre-merge era's only reachable retirement: a consumption that never
    // happened. Merging must not be blocked by it, and must not preserve it.
    await pipeline.applyEvent(loser.ulid, 'finished', { at: '2026-07-19' });

    const result = await pipeline.mergeItems(loser.ulid, survivor.ulid);
    expect(result!.merged.state).toBe('dismissed');
    expect(result!.merged.merged_into).toBe(survivor.ulid);
    // The original close date is kept — the merge corrects the CLAIM, not the date.
    expect(result!.merged.closed_at).toBe('2026-07-19');
  });

  it('is idempotent on a replay and refuses a self-merge, an unknown side, or a cross-target replay', async () => {
    const { entries, pipeline } = harness();
    const { item: survivor } = await pipeline.createItem({ raw_label: 'A', acquired_at: '2026-07-18' });
    const { item: loser } = await pipeline.createItem({ raw_label: 'B', acquired_at: '2026-07-18' });
    const { item: third } = await pipeline.createItem({ raw_label: 'C', acquired_at: '2026-07-18' });
    const { record: entry } = await entries.insertIfAbsent({
      ulid: ULID(75), logged_at: new Date('2026-07-19T12:00:00Z'), note: 'B',
      recipe_ulid: null, component_quantities: null,
    });
    await entries.linkInventoryItem(entry.ulid, loser.ulid);

    const first = await pipeline.mergeItems(loser.ulid, survivor.ulid);
    expect(first!.relinked.entries).toBe(1);
    const closedAt = first!.merged.closed_at;

    const replay = await pipeline.mergeItems(loser.ulid, survivor.ulid);
    expect(replay!.relinked.entries).toBe(0);
    expect(replay!.merged.closed_at).toBe(closedAt);

    expect(pipeline.mergeItems(survivor.ulid, survivor.ulid)).rejects.toThrow(ItemValidationError);
    expect(await pipeline.mergeItems(survivor.ulid, ULID(76))).toBeNull();
    expect(pipeline.mergeItems(loser.ulid, third.ulid)).rejects.toThrow(ItemConflictError);
    // And a survivor that was itself merged away is refused.
    expect(pipeline.mergeItems(third.ulid, loser.ulid)).rejects.toThrow(ItemConflictError);
  });

  it('reports entries: 0 rather than claiming a move when the entries hook is unwired', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log); // no relinkEntries
    const { item: survivor } = await pipeline.createItem({ raw_label: 'A', acquired_at: '2026-07-18' });
    const { item: loser } = await pipeline.createItem({ raw_label: 'B', acquired_at: '2026-07-18' });
    const result = await pipeline.mergeItems(loser.ulid, survivor.ulid);
    expect(result!.relinked.entries).toBe(0);
  });
});

describe('unit-count model (§ count-vs-fraction)', () => {
  it('a receipt line with a lexicon package count seeds units_total/units_remaining, not a fraction', async () => {
    const store = new MemoryInventoryStore();
    const product = await store.insertProduct({
      ulid: ULID(60),
      name: 'Sparkling Water',
      shelf_life_class: 'pantry',
      aliases: [],
      nutrition_per_100g: null,
      ingredients: null,
      package_size: '12 oz',
      shelf_life_days_unopened: null,
      shelf_life_days_opened: null,
    });
    await store.upsertLexicon({
      ulid: ULID(61),
      store: 'Example Grocer',
      line_text: 'SPARKLING WATER 3PK',
      product_ulid: product.ulid,
      package_size: '3 ct',
      shelf_life_class: 'pantry',
    });
    const parser = new FakeReceiptParser({ store: 'Example Grocer', lines: [{ text: 'SPARKLING WATER 3PK' }] });
    const pipeline = new InventoryPipeline(store, parser, null, log);
    await pipeline.ingestReceipt({ ulid: ULID(62), store: 'Example Grocer', purchased_at: '2026-07-18' }, [photo]);
    await pipeline.settle();

    const [item] = await pipeline.listInventory({});
    expect(item!.units_total).toBe(3);
    expect(item!.units_remaining).toBe(3);
    expect(item!.on_hand_fraction).toBe(1); // derived from the count: 3 of 3
    // Receipt text can't tell a can pack from a sausage pack ("3 CT" fits both),
    // so seeding leaves the seal unstated — read as `individual`.
    expect(item!.unit_seal).toBe('individual');
  });

  it('a plain package size (no count) stays fraction-modeled, unchanged', async () => {
    const store = new MemoryInventoryStore();
    const product = await store.insertProduct({
      ulid: ULID(63),
      name: 'Feta Cheese',
      shelf_life_class: 'fridge_short',
      aliases: [],
      nutrition_per_100g: null,
      ingredients: null,
      package_size: '8 oz',
      shelf_life_days_unopened: null,
      shelf_life_days_opened: null,
    });
    await store.upsertLexicon({
      ulid: ULID(64),
      store: 'Example Grocer',
      line_text: 'FETA CHEESE',
      product_ulid: product.ulid,
      package_size: '8 oz',
      shelf_life_class: 'fridge_short',
    });
    const parser = new FakeReceiptParser({ store: 'Example Grocer', lines: [{ text: 'FETA CHEESE' }] });
    const pipeline = new InventoryPipeline(store, parser, null, log);
    await pipeline.ingestReceipt({ ulid: ULID(65), store: 'Example Grocer', purchased_at: '2026-07-18' }, [photo]);
    await pipeline.settle();

    const [item] = await pipeline.listInventory({});
    expect(item!.units_total).toBeNull();
    expect(item!.units_remaining).toBeNull();
    expect(item!.on_hand_fraction).toBe(1);
    expect(item!.unit_seal).toBeNull(); // no seal to describe on a divisible container
  });

  it("'finished-unit' decrements one sealed unit; only the opened unit carries the opened-clock; sealed remainder keeps unopened shelf-life", async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({
      raw_label: 'Canned Beans 3pk',
      shelf_life_class: 'pantry', // unopened 365 / opened 180
      acquired_at: '2026-07-01',
      units_total: 3,
    });
    expect(item.units_remaining).toBe(3);

    const opened = await pipeline.applyEvent(item.ulid, 'opened', { at: '2026-07-05' });
    expect(opened!.state).toBe('open');
    expect(opened!.eat_by).toBe('2027-01-01'); // pantry opened window, 180 days from 07-05

    const one = await pipeline.applyEvent(item.ulid, 'finished-unit', { at: '2026-07-20' });
    expect(one!.units_remaining).toBe(2);
    // Reverts to stocked with a fresh unopened-window clock (the next unit is
    // still sealed — it was never itself opened).
    expect(one!.state).toBe('stocked');
    expect(one!.opened_at).toBeNull();
    expect(one!.eat_by).toBe('2027-07-01'); // pantry UNOPENED window, 365 days from acquired_at

    const two = await pipeline.applyEvent(item.ulid, 'finished-unit', { at: '2026-08-01' });
    expect(two!.units_remaining).toBe(1);
    expect(two!.state).toBe('stocked');

    const three = await pipeline.applyEvent(item.ulid, 'finished-unit', { at: '2026-08-15' });
    expect(three!.units_remaining).toBe(0);
    expect(three!.state).toBe('finished'); // zero remaining → terminal
    expect(three!.closed_at).toBe('2026-08-15');

    // Terminal now — a further finished-unit rejects.
    await expect(pipeline.applyEvent(item.ulid, 'finished-unit', {})).rejects.toThrow(InvalidTransitionError);
  });

  it("'finished-unit' on a fraction-modeled item throws NotCountedItemError", async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({ raw_label: 'Milk', shelf_life_class: 'fridge_short', acquired_at: '2026-07-01' });
    await expect(pipeline.applyEvent(item.ulid, 'finished-unit', {})).rejects.toThrow(NotCountedItemError);
  });

  it("a whole-item 'finished' on a counted item zeroes units_remaining too", async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({ raw_label: 'Egg dozen', shelf_life_class: 'fridge_long', acquired_at: '2026-07-01', units_total: 12 });
    expect((await pipeline.getItemView(item.ulid))!.units_remaining).toBe(12);
    const finished = await pipeline.applyEvent(item.ulid, 'finished', {});
    expect(finished!.state).toBe('finished');
    expect(finished!.units_remaining).toBe(0);
  });

  it('a counted item’s on_hand_fraction is DERIVED from the count on every read', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({
      raw_label: 'Link Sausage 4-count',
      shelf_life_class: 'fridge_short',
      acquired_at: '2026-07-01',
      units_total: 4,
      unit_seal: 'shared',
    });
    expect(item.on_hand_fraction).toBe(1);
    const three = await pipeline.applyEvent(item.ulid, 'finished-unit', { at: '2026-07-02' });
    expect(three!.units_remaining).toBe(3);
    expect(three!.on_hand_fraction).toBe(0.75);
    const two = await pipeline.applyEvent(item.ulid, 'finished-unit', { at: '2026-07-03' });
    expect(two!.on_hand_fraction).toBe(0.5);
    // …and the read path agrees with the write path.
    expect((await pipeline.getItemView(item.ulid))!.on_hand_fraction).toBe(0.5);
  });

  it('rejects a unit_seal with no count — there is no seal to describe on a divisible item', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    await expect(
      pipeline.createItem({ raw_label: 'Yogurt tub', shelf_life_class: 'fridge_short', unit_seal: 'shared' })
    ).rejects.toThrow(ItemValidationError);
  });

  describe('counted within an OPEN container (unit_seal: shared)', () => {
    // A 4-link vacuum pack: one seal over four units. Opening the container puts
    // the whole remainder on the opened clock, and eating a link re-seals nothing.
    const pack = async (pipeline: InventoryPipeline) =>
      (
        await pipeline.createItem({
          raw_label: 'Link Sausage 4-count',
          shelf_life_class: 'fridge_short', // unopened 14 / opened 7
          acquired_at: '2026-07-01',
          units_total: 4,
          unit_seal: 'shared',
        })
      ).item;

    it('keeps the count AND the opened clock — the choice the model used to force', async () => {
      const store = new MemoryInventoryStore();
      const pipeline = new InventoryPipeline(store, null, null, log);
      const item = await pack(pipeline);

      const opened = await pipeline.applyEvent(item.ulid, 'opened', { at: '2026-07-05' });
      expect(opened!.state).toBe('open');
      expect(opened!.eat_by).toBe('2026-07-12'); // opened window, 7 d from 07-05

      const three = await pipeline.applyEvent(item.ulid, 'finished-unit', { at: '2026-07-06' });
      // Both facts survive: the count moved, and the container is still open on
      // the SAME clock (no fresh unopened window for an exposed remainder).
      expect(three!.units_remaining).toBe(3);
      expect(three!.state).toBe('open');
      expect(three!.opened_at).toBe('2026-07-05');
      expect(three!.eat_by).toBe('2026-07-12');

      const two = await pipeline.applyEvent(item.ulid, 'finished-unit', { at: '2026-07-08' });
      expect(two!.units_remaining).toBe(2);
      expect(two!.state).toBe('open');
      expect(two!.eat_by).toBe('2026-07-12'); // still the container's clock
    });

    it('implies the open when the first unit goes from a still-sealed pack', async () => {
      const store = new MemoryInventoryStore();
      const pipeline = new InventoryPipeline(store, null, null, log);
      const item = await pack(pipeline);
      expect(item.state).toBe('stocked');
      expect(item.eat_by).toBe('2026-07-15'); // unopened window, 14 d

      // You can't eat one link out of a sealed pack, so the depletion IS the open.
      const three = await pipeline.applyEvent(item.ulid, 'finished-unit', { at: '2026-07-05' });
      expect(three!.state).toBe('open');
      expect(three!.opened_at).toBe('2026-07-05');
      expect(three!.eat_by).toBe('2026-07-12'); // opened window from the event date
    });

    it('still goes terminal on the last unit, like any counted item', async () => {
      const store = new MemoryInventoryStore();
      const pipeline = new InventoryPipeline(store, null, null, log);
      const item = await pack(pipeline);
      for (const day of ['2026-07-05', '2026-07-06', '2026-07-07']) {
        await pipeline.applyEvent(item.ulid, 'finished-unit', { at: day });
      }
      const last = await pipeline.applyEvent(item.ulid, 'finished-unit', { at: '2026-07-08' });
      expect(last!.units_remaining).toBe(0);
      expect(last!.state).toBe('finished');
      expect(last!.closed_at).toBe('2026-07-08');
      expect(last!.on_hand_fraction).toBe(0);
    });

    it('reconcile can reclassify the seal, and dropping the count drops the seal with it', async () => {
      const store = new MemoryInventoryStore();
      const pipeline = new InventoryPipeline(store, null, null, log);
      const item = await pack(pipeline);

      const individual = await pipeline.reconcileItem(item.ulid, { unit_seal: 'individual' });
      expect(individual!.unit_seal).toBe('individual');
      expect(individual!.notes).toContain('unit_seal shared→individual');

      // Reverting to the fraction model leaves no seal behind to mean anything.
      const uncounted = await pipeline.reconcileItem(item.ulid, { units_total: null, units_remaining: null });
      expect(uncounted!.units_total).toBeNull();
      expect(uncounted!.unit_seal).toBeNull();

      // …and a seal can't be set without a count.
      await expect(pipeline.reconcileItem(item.ulid, { unit_seal: 'shared' })).rejects.toThrow(
        ReconcileValidationError
      );
    });

    it('the three-way interaction: an opened shared pack MOVED between storages', async () => {
      // Where all of storage moves, the open container, and the count meet.
      const store = new MemoryInventoryStore();
      const pipeline = new InventoryPipeline(store, null, null, log);
      const item = await pack(pipeline);
      await pipeline.applyEvent(item.ulid, 'opened', { at: '2026-07-05' });
      await pipeline.applyEvent(item.ulid, 'finished-unit', { at: '2026-07-06' });

      // Into the freezer on the 7th to stop the clock on the remaining links.
      const frozen = await pipeline.applyEvent(item.ulid, 'moved', { to: 'frozen', at: '2026-07-07' });
      expect(frozen!.units_remaining).toBe(3); // count survives
      expect(frozen!.state).toBe('open'); // still an open container
      expect(frozen!.opened_at).toBe('2026-07-05');
      expect(frozen!.shelf_life_class).toBe('frozen');
      // frozen's OPENED window (90 d) from the MOVE date, not from opened_at.
      expect(frozen!.eat_by).toBe('2026-10-05');
      expect(frozen!.on_hand_fraction).toBe(0.75);

      // Back out to the fridge on the 20th: the fridge opened window restarts
      // from the thaw, and the count is still 3.
      const thawed = await pipeline.applyEvent(item.ulid, 'moved', { to: 'fridge_short', at: '2026-07-20' });
      expect(thawed!.eat_by).toBe('2026-07-27'); // 7 d from the thaw
      expect(thawed!.units_remaining).toBe(3);
      expect(thawed!.state).toBe('open');

      // Eating a link after the round trip keeps the thawed container's clock.
      const two = await pipeline.applyEvent(item.ulid, 'finished-unit', { at: '2026-07-21' });
      expect(two!.units_remaining).toBe(2);
      expect(two!.state).toBe('open');
      expect(two!.eat_by).toBe('2026-07-27');
    });
  });
});

describe('storage moves (§ Storage moves)', () => {
  const frozenPack = async (pipeline: InventoryPipeline) =>
    (
      await pipeline.createItem({
        raw_label: 'Vacuum-Sealed Cooked Sausage',
        shelf_life_class: 'frozen', // unopened 180 / opened 90
        acquired_at: '2026-07-01',
      })
    ).item;

  it('re-anchors the clock from the move date rather than resuming the old one', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const item = await frozenPack(pipeline);
    expect(item.eat_by).toBe('2026-12-28'); // frozen unopened, 180 d

    const thawed = await pipeline.applyEvent(item.ulid, 'moved', { to: 'fridge_short', at: '2026-07-09' });
    expect(thawed!.shelf_life_class).toBe('fridge_short');
    expect(thawed!.storage_moved_at).toBe('2026-07-09');
    // 14 d from the THAW (07-23). Resuming from acquisition would say 07-15,
    // which is the whole defect: the pack was safe in the freezer for 8 days.
    expect(thawed!.eat_by).toBe('2026-07-23');
    // State and opened_at untouched — moving a sealed pack does not open it.
    expect(thawed!.state).toBe('stocked');
    expect(thawed!.opened_at).toBeNull();
    expect(thawed!.notes).toContain('moved frozen→fridge_short 2026-07-09');
  });

  it('works inverted — fridge→freezer parks the clock on the destination window', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({
      raw_label: 'Ground Turkey',
      shelf_life_class: 'fridge_short',
      acquired_at: '2026-07-01',
    });
    expect(item.eat_by).toBe('2026-07-15');
    const parked = await pipeline.applyEvent(item.ulid, 'moved', { to: 'frozen', at: '2026-07-03' });
    expect(parked!.eat_by).toBe('2026-12-30'); // frozen unopened, 180 d from the move
    expect(parked!.state).toBe('stocked');
  });

  it('an already-open item keeps its open state and takes the destination OPENED window', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({
      raw_label: 'Soup Batch',
      shelf_life_class: 'fridge_short',
      acquired_at: '2026-07-01',
    });
    await pipeline.applyEvent(item.ulid, 'opened', { at: '2026-07-02' });
    const moved = await pipeline.applyEvent(item.ulid, 'moved', { to: 'frozen', at: '2026-07-04' });
    expect(moved!.state).toBe('open');
    expect(moved!.opened_at).toBe('2026-07-02'); // not re-sealed by the move
    expect(moved!.eat_by).toBe('2026-10-02'); // frozen OPENED window (90 d) from the move
  });

  it('takes the reported date at face value — the act’s date, not the intention’s', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const item = await frozenPack(pipeline);
    // Reported as having happened on the 9th, logged later: the anchor is the
    // 9th. Intention and act routinely land on different days, and anchoring to
    // the intention silently mis-sizes a real safety window.
    const thawed = await pipeline.applyEvent(item.ulid, 'moved', { to: 'produce', at: '2026-07-09' });
    expect(thawed!.storage_moved_at).toBe('2026-07-09');
    expect(thawed!.eat_by).toBe('2026-07-16'); // produce unopened, 7 d from the 9th
  });

  it('repeated moves re-anchor to the latest and keep every line of history', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const item = await frozenPack(pipeline);
    await pipeline.applyEvent(item.ulid, 'moved', { to: 'fridge_short', at: '2026-07-05' });
    const back = await pipeline.applyEvent(item.ulid, 'moved', { to: 'frozen', at: '2026-07-06' });
    const again = await pipeline.applyEvent(back!.ulid, 'moved', { to: 'fridge_short', at: '2026-07-20' });
    expect(again!.storage_moved_at).toBe('2026-07-20'); // only the current storage governs
    expect(again!.eat_by).toBe('2026-08-03');
    // …but the transition history survives in provenance.
    expect(again!.notes).toContain('moved frozen→fridge_short 2026-07-05');
    expect(again!.notes).toContain('moved fridge_short→frozen 2026-07-06');
    expect(again!.notes).toContain('moved frozen→fridge_short 2026-07-20');
  });

  it('a move into the SAME class is not a no-op — it re-anchors', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({
      raw_label: 'Deli Turkey',
      shelf_life_class: 'fridge_short',
      acquired_at: '2026-07-01',
    });
    expect(item.eat_by).toBe('2026-07-15');
    // "It entered the fridge today" — the class was right, the basis wasn't.
    const moved = await pipeline.applyEvent(item.ulid, 'moved', { to: 'fridge_short', at: '2026-07-08' });
    expect(moved!.eat_by).toBe('2026-07-22');
  });

  it("rejects a move with no destination, a move to 'unknown', and a `to` on any other verb", async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const item = await frozenPack(pipeline);
    await expect(pipeline.applyEvent(item.ulid, 'moved', {})).rejects.toThrow(ItemValidationError);
    await expect(pipeline.applyEvent(item.ulid, 'moved', { to: 'unknown' })).rejects.toThrow(
      ItemValidationError
    );
    // A `to` on a consumption verb would be silently ignored; refuse instead.
    await expect(pipeline.applyEvent(item.ulid, 'opened', { to: 'frozen' })).rejects.toThrow(
      ItemValidationError
    );
  });

  it('rejects a move on a terminal item, like every other event', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const item = await frozenPack(pipeline);
    await pipeline.applyEvent(item.ulid, 'finished', { at: '2026-07-04' });
    await expect(
      pipeline.applyEvent(item.ulid, 'moved', { to: 'fridge_short', at: '2026-07-05' })
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('a frozen item keeps its eat_by and sorts below perishables rather than being suppressed', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    await pipeline.createItem({ raw_label: 'Frozen Pack', shelf_life_class: 'frozen', acquired_at: '2026-07-01' });
    await pipeline.createItem({ raw_label: 'Bagged Greens', shelf_life_class: 'produce', acquired_at: '2026-07-01' });
    const items = await pipeline.listInventory({});
    // Eat-first is eat_by ASC nulls last, so 180 days already de-prioritizes the
    // frozen item — without discarding the honest "it's been in there a while"
    // signal that a null eat_by would throw away.
    expect(items.map((i) => i.raw_label)).toEqual(['Bagged Greens', 'Frozen Pack']);
    expect(items[1]!.eat_by).toBe('2026-12-28');
  });

  it('a `moved` that only changes storage never touches the count or the fraction', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({
      raw_label: 'Frozen Patties 6-count',
      shelf_life_class: 'frozen',
      acquired_at: '2026-07-01',
      units_total: 6,
    });
    await pipeline.applyEvent(item.ulid, 'finished-unit', { at: '2026-07-02' });
    const moved = await pipeline.applyEvent(item.ulid, 'moved', { to: 'fridge_short', at: '2026-07-03' });
    expect(moved!.units_total).toBe(6);
    expect(moved!.units_remaining).toBe(5);
    expect(moved!.on_hand_fraction).toBeCloseTo(5 / 6, 10);
  });
});

describe('conversions (prep transforms — § Conversions)', () => {
  it('converts a counted source (6 of 12 eggs) into a counted derived item with provenance', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item: eggs } = await pipeline.createItem({
      raw_label: 'Egg dozen', shelf_life_class: 'fridge_long', acquired_at: '2026-07-01', units_total: 12,
    });

    const result = await pipeline.convert({
      sources: [{ item_ulid: eggs.ulid, amount: 6 }],
      derived: { name: 'Hard-boiled eggs', shelf_life_class: 'produce', units_total: 6 },
      at: '2026-07-10',
    });

    expect(result.sources.length).toBe(1);
    expect(result.sources[0]!.units_remaining).toBe(6); // 12 - 6
    expect(result.sources[0]!.state).toBe('stocked'); // still alive, half the pack left

    expect(result.derived.raw_label).toBe('Hard-boiled eggs');
    expect(result.derived.units_total).toBe(6);
    expect(result.derived.units_remaining).toBe(6);
    expect(result.derived.eat_by).toBe('2026-07-17'); // produce unopened 7 days from 07-10 (made-food class; hard-boiled eggs keep ~a week)
    expect(result.derived.derived_from?.sources).toEqual([{ item_ulid: eggs.ulid, amount: 6, amount_kind: 'count' }]);

    // Provenance persists on a fresh read too.
    const reread = await pipeline.getItemView(result.derived.ulid);
    expect(reread!.derived_from?.sources[0]!.item_ulid).toBe(eggs.ulid);

    // The derived item is first-class eat-first stock.
    const onHand = await pipeline.listInventory({});
    expect(onHand.some((i) => i.ulid === result.derived.ulid)).toBe(true);
  });

  it('converts a fraction source (some quinoa) into a divisible derived item; omitted amount fully consumes', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item: quinoa } = await pipeline.createItem({
      raw_label: 'Dry quinoa', shelf_life_class: 'pantry', acquired_at: '2026-07-01',
    });
    expect(quinoa.on_hand_fraction).toBe(1);

    const result = await pipeline.convert({
      sources: [{ item_ulid: quinoa.ulid, amount: 0.3 }],
      derived: { name: 'Cooked quinoa', shelf_life_class: 'prepared', on_hand_fraction: 1, recipe_ulid: null },
      at: '2026-07-10',
    });
    expect(result.sources[0]!.on_hand_fraction).toBeCloseTo(0.7, 5);
    expect(result.sources[0]!.state).toBe('stocked');
    expect(result.derived.on_hand_fraction).toBe(1);
    expect(result.derived.units_total).toBeNull();
    expect(result.derived.derived_from?.sources[0]!.amount_kind).toBe('fraction');

    // A second conversion with NO amount fully consumes the remainder.
    const second = await pipeline.convert({
      sources: [{ item_ulid: quinoa.ulid }],
      derived: { name: 'More cooked quinoa', shelf_life_class: 'prepared' },
      at: '2026-07-12',
    });
    expect(second.sources[0]!.on_hand_fraction).toBe(0);
    expect(second.sources[0]!.state).toBe('finished');
  });

  it('rejects a terminal source (nothing left to spend)', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({ raw_label: 'Old milk', shelf_life_class: 'fridge_short', acquired_at: '2026-07-01' });
    await pipeline.applyEvent(item.ulid, 'finished', {});
    await expect(
      pipeline.convert({ sources: [{ item_ulid: item.ulid }], derived: { name: 'Something' } })
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects an unknown source and a missing derived name', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    await expect(
      pipeline.convert({ sources: [{ item_ulid: '01JMISSINGMISSINGMISSING0' }], derived: { name: 'X' } })
    ).rejects.toThrow(ConversionValidationError);

    const { item } = await pipeline.createItem({ raw_label: 'Milk', shelf_life_class: 'fridge_short', acquired_at: '2026-07-01' });
    await expect(
      pipeline.convert({ sources: [{ item_ulid: item.ulid }], derived: { name: '' } })
    ).rejects.toThrow(ConversionValidationError);
  });

  it('rejects a non-integer amount against a counted source', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({ raw_label: 'Egg dozen', shelf_life_class: 'fridge_long', acquired_at: '2026-07-01', units_total: 12 });
    await expect(
      pipeline.convert({ sources: [{ item_ulid: item.ulid, amount: 2.5 }], derived: { name: 'Eggs' } })
    ).rejects.toThrow(ConversionValidationError);
  });

  // § Shelf-life classes — "A `convert` derived item accepts only made-food
  // shelf-life classes". The package-durable classes anchor to a sealed-package
  // unopened window, absurd on a homemade item; the guard makes it impossible.
  describe('made-food shelf-life guard (§ Shelf-life classes)', () => {
    for (const badClass of ['fridge_short', 'pantry', 'fridge_long'] as const) {
      it(`rejects the package-durable class '${badClass}' with guidance naming the made-food set — no item created`, async () => {
        const store = new MemoryInventoryStore();
        const pipeline = new InventoryPipeline(store, null, null, log);
        const before = await pipeline.listInventory({});

        const attempt = pipeline.convert({
          derived: { name: 'Batch jar', shelf_life_class: badClass },
          at: '2026-07-10',
        });
        await expect(attempt).rejects.toThrow(ConversionValidationError);
        // The message names the valid made-food set and points at `prepared`.
        await expect(attempt).rejects.toThrow(/prepared, produce, very_perishable, frozen/);
        await expect(attempt).rejects.toThrow(/prepared/);

        // No item was minted on rejection — the guard runs before any write.
        const after = await pipeline.listInventory({});
        expect(after.length).toBe(before.length);
        expect(after.some((i) => i.raw_label === 'Batch jar')).toBe(false);
      });
    }

    it('the guard fires before decrementing any source (no side effects on rejection)', async () => {
      const store = new MemoryInventoryStore();
      const pipeline = new InventoryPipeline(store, null, null, log);
      const { item: eggs } = await pipeline.createItem({
        raw_label: 'Egg dozen', shelf_life_class: 'fridge_long', acquired_at: '2026-07-01', units_total: 12,
      });

      await expect(
        pipeline.convert({
          sources: [{ item_ulid: eggs.ulid, amount: 6 }],
          derived: { name: 'Hard-boiled eggs', shelf_life_class: 'fridge_short', units_total: 6 },
          at: '2026-07-10',
        })
      ).rejects.toThrow(ConversionValidationError);

      // The source was NOT decremented — all 12 remain.
      const reread = await pipeline.getItemView(eggs.ulid);
      expect(reread!.units_remaining).toBe(12);
    });

    // Every made-food class passes and derives the expected eat-by (made 07-10).
    const madeFoodCases: { cls: 'prepared' | 'produce' | 'very_perishable' | 'frozen'; eatBy: string }[] = [
      { cls: 'prepared', eatBy: '2026-07-14' }, // 4 days from make
      { cls: 'produce', eatBy: '2026-07-17' }, // 7 days
      { cls: 'very_perishable', eatBy: '2026-07-13' }, // 3 days
      { cls: 'frozen', eatBy: '2027-01-06' }, // 180 days
    ];
    for (const { cls, eatBy } of madeFoodCases) {
      it(`accepts the made-food class '${cls}' and derives its eat-by`, async () => {
        const store = new MemoryInventoryStore();
        const pipeline = new InventoryPipeline(store, null, null, log);
        const result = await pipeline.convert({
          derived: { name: 'Batch jar', shelf_life_class: cls },
          at: '2026-07-10',
        });
        expect(result.derived.shelf_life_class).toBe(cls);
        expect(result.derived.eat_by).toBe(eatBy);
      });
    }

    it('an omitted shelf_life_class still defaults to `prepared` (4 d from make)', async () => {
      const store = new MemoryInventoryStore();
      const pipeline = new InventoryPipeline(store, null, null, log);
      const result = await pipeline.convert({
        derived: { name: 'Batch jar' },
        at: '2026-07-10',
      });
      expect(result.derived.shelf_life_class).toBe('prepared');
      expect(result.derived.eat_by).toBe('2026-07-14'); // 4 days from make date
    });
  });

  // § Conversions § Atomicity. A prep transform is exactly where several tracked
  // inputs are spent at once, and a mid-sequence failure fails in the direction
  // where the ledger claims LESS stock than reality — nothing downstream flags
  // it, so it resurfaces later as unexplained drift. Store-level coverage of the
  // rollback itself is in inventory-store.test.ts; these prove the pipeline runs
  // through it and that a rejected request never opens a transaction.
  describe('atomicity (§ Conversions § Atomicity)', () => {
    async function multiSourcePipeline(hooks: MemoryInventoryStoreTestHooks = {}) {
      const store = new MemoryInventoryStore(hooks);
      const pipeline = new InventoryPipeline(store, null, null, log);
      const { item: eggs } = await pipeline.createItem({
        raw_label: 'Egg dozen', shelf_life_class: 'fridge_long', acquired_at: '2026-07-01', units_total: 12,
      });
      const { item: yogurt } = await pipeline.createItem({
        raw_label: 'Yogurt tub', shelf_life_class: 'fridge_short', acquired_at: '2026-07-08',
      });
      const { item: oats } = await pipeline.createItem({
        raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-06-01',
      });
      return { store, pipeline, eggs, yogurt, oats };
    }

    const threeSources = (eggs: string, yogurt: string, oats: string) => ({
      sources: [
        { item_ulid: eggs, amount: 6 },
        { item_ulid: yogurt }, // omitted → fully consumed, goes terminal
        { item_ulid: oats, amount: 0.25 },
      ],
      derived: { name: 'Sunday batch', units_total: 4 },
      at: '2026-07-12',
    });

    it('a failure creating the derived item rolls back EVERY source, not just the last', async () => {
      const { store, pipeline, eggs, yogurt, oats } = await multiSourcePipeline({
        beforeDerivedInsert: () => {
          throw new Error('derived insert failed');
        },
      });

      await expect(pipeline.convert(threeSources(eggs.ulid, yogurt.ulid, oats.ulid))).rejects.toThrow(
        'derived insert failed'
      );

      // Every input is exactly where it was — including the first-planned source,
      // the one a partial undo would leave spent.
      const eggsAfter = await pipeline.getItemView(eggs.ulid);
      expect(eggsAfter!.units_remaining).toBe(12);
      expect(eggsAfter!.state).toBe('stocked');
      const yogurtAfter = await pipeline.getItemView(yogurt.ulid);
      expect(yogurtAfter!.state).toBe('stocked'); // NOT finished
      expect(yogurtAfter!.on_hand_fraction).toBe(1);
      expect(yogurtAfter!.closed_at).toBeNull();
      const oatsAfter = await pipeline.getItemView(oats.ulid);
      expect(oatsAfter!.on_hand_fraction).toBe(1);

      // And the output never appeared.
      const onHand = await pipeline.listInventory({});
      expect(onHand.some((i) => i.raw_label === 'Sunday batch')).toBe(false);
      expect(onHand).toHaveLength(3);
      expect(store.derivations.size).toBe(0);
    });

    it('a failure recording provenance leaves the derived item invisible, sources unspent', async () => {
      const { store, pipeline, eggs, yogurt, oats } = await multiSourcePipeline({
        beforeDerivationInsert: () => {
          throw new Error('derivation insert failed');
        },
      });

      await expect(pipeline.convert(threeSources(eggs.ulid, yogurt.ulid, oats.ulid))).rejects.toThrow(
        'derivation insert failed'
      );

      // A derived item with no provenance is not consume-eligible and has no cost
      // attribution, so it must not survive the failure either.
      const onHand = await pipeline.listInventory({});
      expect(onHand.some((i) => i.raw_label === 'Sunday batch')).toBe(false);
      expect(onHand).toHaveLength(3);
      expect(store.derivations.size).toBe(0);
      expect((await pipeline.getItemView(eggs.ulid))!.units_remaining).toBe(12);
      expect((await pipeline.getItemView(yogurt.ulid))!.state).toBe('stocked');
    });

    it('a rejected request never reaches the write phase (validation runs before it)', async () => {
      // The hooks fire INSIDE the atomic write, so tripping one would prove the
      // write phase opened. A request rejected in validation must never get there.
      const { pipeline, eggs, yogurt } = await multiSourcePipeline({
        beforeDerivedInsert: () => {
          throw new Error('the write phase must not have been reached');
        },
      });

      // A terminal source, an unknown source, a bad amount, a missing name, and a
      // package-durable class each reject without opening the write.
      await pipeline.applyEvent(yogurt.ulid, 'finished', {});
      for (const bad of [
        { sources: [{ item_ulid: eggs.ulid, amount: 6 }, { item_ulid: yogurt.ulid }], derived: { name: 'X' } },
        { sources: [{ item_ulid: eggs.ulid }, { item_ulid: '01JMISSINGMISSINGMISSING0' }], derived: { name: 'X' } },
        { sources: [{ item_ulid: eggs.ulid, amount: 2.5 }], derived: { name: 'X' } },
        { sources: [{ item_ulid: eggs.ulid, amount: 1 }], derived: { name: '  ' } },
        { sources: [{ item_ulid: eggs.ulid, amount: 1 }], derived: { name: 'X', shelf_life_class: 'pantry' as const } },
      ]) {
        const attempt = pipeline.convert({ ...bad, at: '2026-07-12' });
        await expect(attempt).rejects.toThrow();
        await expect(attempt).rejects.not.toThrow('the write phase must not have been reached');
      }

      // Nothing was spent by any of the five rejections.
      expect((await pipeline.getItemView(eggs.ulid))!.units_remaining).toBe(12);
    });

    it('a successful multi-source convert is unchanged — every source spent, derived item stocked, provenance complete', async () => {
      const { store, pipeline, eggs, yogurt, oats } = await multiSourcePipeline();

      const result = await pipeline.convert(threeSources(eggs.ulid, yogurt.ulid, oats.ulid));

      expect(result.sources.map((s) => s.ulid)).toEqual([eggs.ulid, yogurt.ulid, oats.ulid]);
      expect(result.sources[0]!.units_remaining).toBe(6);
      expect(result.sources[0]!.state).toBe('stocked');
      expect(result.sources[1]!.state).toBe('finished'); // omitted amount fully consumed it
      expect(result.sources[1]!.on_hand_fraction).toBe(0);
      expect(result.sources[2]!.on_hand_fraction).toBeCloseTo(0.75, 5);
      expect(result.sources[2]!.state).toBe('stocked');

      expect(result.derived.raw_label).toBe('Sunday batch');
      expect(result.derived.state).toBe('stocked');
      expect(result.derived.units_total).toBe(4);
      expect(result.derived.shelf_life_class).toBe('prepared');
      expect(result.derived.eat_by).toBe('2026-07-16'); // prepared, 4 d from the make date
      expect(result.derived.derived_from?.sources).toEqual([
        { item_ulid: eggs.ulid, amount: 6, amount_kind: 'count' },
        { item_ulid: yogurt.ulid, amount: 1, amount_kind: 'fraction' },
        { item_ulid: oats.ulid, amount: 0.25, amount_kind: 'fraction' },
      ]);
      expect(result.derivation.derived_item_ulid).toBe(result.derived.ulid);

      // Persisted, not just returned: the derived item joins eat-first stock and
      // its provenance re-reads.
      const onHand = await pipeline.listInventory({});
      expect(onHand.some((i) => i.ulid === result.derived.ulid)).toBe(true);
      expect(store.derivations.get(result.derived.ulid)!.sources).toHaveLength(3);
      const reread = await pipeline.getItemView(result.derived.ulid);
      expect(reread!.derived_from?.sources).toHaveLength(3);
    });

    it('one source spent twice in a single convert decrements twice, not once', async () => {
      // The planner projects each decrement forward, so the second line sees the
      // remainder the first left — the same result the old write-as-you-go loop's
      // re-read produced.
      const { pipeline, eggs } = await multiSourcePipeline();

      const result = await pipeline.convert({
        sources: [
          { item_ulid: eggs.ulid, amount: 4 },
          { item_ulid: eggs.ulid, amount: 3 },
        ],
        derived: { name: 'Two-line batch' },
        at: '2026-07-12',
      });

      expect((await pipeline.getItemView(eggs.ulid))!.units_remaining).toBe(5); // 12 - 4 - 3
      expect(result.derived.derived_from?.sources).toEqual([
        { item_ulid: eggs.ulid, amount: 4, amount_kind: 'count' },
        { item_ulid: eggs.ulid, amount: 3, amount_kind: 'count' },
      ]);
    });

    it('a source driven terminal by an earlier line in the SAME convert is rejected, spending nothing', async () => {
      const { pipeline, eggs } = await multiSourcePipeline();

      await expect(
        pipeline.convert({
          sources: [
            { item_ulid: eggs.ulid, amount: 12 }, // spends the whole pack → finished
            { item_ulid: eggs.ulid, amount: 1 }, // nothing left to spend
          ],
          derived: { name: 'Over-spent batch' },
          at: '2026-07-12',
        })
      ).rejects.toThrow(InvalidTransitionError);

      // The first line's decrement was planned, never written.
      const after = await pipeline.getItemView(eggs.ulid);
      expect(after!.units_remaining).toBe(12);
      expect(after!.state).toBe('stocked');
    });
  });
});

describe('inventory read ordering', () => {
  it('orders on-hand items by eat-by urgency, nulls last', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    await pipeline.createItem({ raw_label: 'Pantry rice', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    await pipeline.createItem({ raw_label: 'Fresh fish', shelf_life_class: 'very_perishable', acquired_at: '2026-07-16' });
    await pipeline.createItem({ raw_label: 'Mystery jar', acquired_at: '2026-07-10', needs_info: true });

    const items = await pipeline.listInventory({});
    expect(items[0]!.raw_label).toBe('Fresh fish'); // soonest eat-by
    expect(items[items.length - 1]!.raw_label).toBe('Mystery jar'); // null eat-by last
  });
});

describe('consume from inventory (claude-assist#110 — one-tap known-macro log + deplete)', () => {
  const RECIPE: RecipeRecord = {
    ulid: ULID(50),
    name: 'Overnight oats',
    components: [
      { label: 'oats', default_qty_g: 240, per_100g: { calories: 380, protein_g: 13, sat_fat_g: 1.2 } },
      { label: 'yogurt', default_qty_g: 300, per_100g: { calories: 60, protein_g: 10, sat_fat_g: 0.2 } },
    ],
    source: 'pushed',
    created_at: new Date(),
    updated_at: new Date(),
    archived_at: null,
  };
  // computeRecipeMacros(RECIPE): calories 240*3.8+300*0.6=912+180=1092, protein
  // 240*0.13+300*0.1=31.2+30=61.2, sat_fat 240*0.012+300*0.002=2.88+0.6=3.48.

  function harness(recipes: RecipeRecord[] = [RECIPE]) {
    const store = new MemoryInventoryStore();
    const entries = new MemoryEntryStore();
    const consumeStore = new MemoryConsumeStore(entries, store);
    const pipeline = new InventoryPipeline(store, null, null, log, {
      consumeStore,
      resolveRecipe: async (ulid) => recipes.find((r) => r.ulid === ulid) ?? null,
    });
    return { store, entries, consumeStore, pipeline };
  }

  it('consumes a counted derived item: 1 of 3 jars — exact macros, integer decrement, source reselect/estimated', async () => {
    const { pipeline, entries } = harness();
    const { item: oats } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: oats.ulid }],
      derived: { name: 'Overnight oats jar', shelf_life_class: 'prepared', units_total: 3, recipe_ulid: RECIPE.ulid },
      at: '2026-07-17',
    });
    expect(derived.units_remaining).toBe(3);

    const result = await pipeline.consume(derived.ulid, { ulid: ULID(60) });
    expect(result).not.toBeNull();
    expect(result!.created).toBe(true);
    expect(result!.entry.ulid).toBe(ULID(60));
    expect(result!.entry.source).toBe('reselect');
    expect(result!.entry.status).toBe('estimated');
    expect(result!.entry.label).toBe('Overnight oats jar');
    // The PER-UNIT recipe contract (§ Consume): the linked recipe describes
    // ONE jar, so one consumed unit logs exactly the recipe's totals — never
    // a share of them (the 2026-07-22 oat-jar regression: ÷3 logged ⅓ jar).
    expect(result!.entry.calories).toBe(1092);
    expect(result!.entry.protein_g).toBe(61.2);
    expect(result!.entry.sat_fat_g).toBe(3.5); // round1(3.48)
    expect(result!.entry.confidence).toBe(1);

    // Depletion: integer decrement, item stays alive (finished-unit semantics).
    expect(result!.item.units_remaining).toBe(2);
    expect(result!.item.state).toBe('stocked');
    expect(result!.item.opened_at).toBeNull();

    // The entry is really in the store, not just the returned snapshot.
    expect(entries.records.get(ULID(60))?.inventory_item_ulid).toBe(derived.ulid);
  });

  it('carries added_sugar_g onto the consumed entry, scaled and null-aware', async () => {
    // Consume-from-inventory is a full-panel write path too (§ Nutrition panel —
    // every source fills the whole panel it can), so the ninth field has to
    // survive the recipe computation AND the share scaling.
    const SWEET_RECIPE: RecipeRecord = {
      ...RECIPE,
      ulid: ULID(51),
      name: 'Sweetened oat jar',
      components: [
        // Plain oats ASSERT zero added sugar; the topping carries a real number.
        { label: 'oats', default_qty_g: 100, per_100g: { calories: 380, protein_g: 13, sat_fat_g: 1.2, sugar_g: 2, added_sugar_g: 0 } },
        { label: 'topping', default_qty_g: 100, per_100g: { calories: 300, protein_g: 1, sat_fat_g: 0.5, sugar_g: 40, added_sugar_g: 30 } },
      ],
    };
    const { pipeline } = harness([SWEET_RECIPE]);
    const { item: oats } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: oats.ulid }],
      derived: { name: 'Sweetened oat jar', shelf_life_class: 'prepared', units_total: 2, recipe_ulid: SWEET_RECIPE.ulid },
      at: '2026-07-17',
    });

    const result = await pipeline.consume(derived.ulid, { ulid: ULID(69) });
    expect(result!.entry.sugar_g).toBe(42);
    expect(result!.entry.added_sugar_g).toBe(30);

    // And a recipe that knows nothing about added sugar leaves it unknown on the
    // consumed entry rather than logging a clean 0.
    const { pipeline: plain } = harness();
    const { item: plainOats } = await plain.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived: plainJar } = await plain.convert({
      sources: [{ item_ulid: plainOats.ulid }],
      derived: { name: 'Overnight oats jar', shelf_life_class: 'prepared', units_total: 1, recipe_ulid: RECIPE.ulid },
      at: '2026-07-17',
    });
    const plainResult = await plain.consume(plainJar.ulid, { ulid: ULID(70) });
    expect(plainResult!.entry.added_sugar_g).toBeNull();
  });

  it('the third and final unit consumed finishes the item (units_remaining reaches 0)', async () => {
    const { pipeline } = harness();
    const { item: oats } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: oats.ulid }],
      derived: { name: 'Overnight oats jar', shelf_life_class: 'prepared', units_total: 1, recipe_ulid: RECIPE.ulid },
      at: '2026-07-17',
    });

    const result = await pipeline.consume(derived.ulid, { ulid: ULID(61) });
    expect(result!.item.state).toBe('finished');
    expect(result!.item.units_remaining).toBe(0);
    expect(result!.item.on_hand_fraction).toBe(0);
  });

  it('depletes a SHARED-seal counted item without re-sealing it (§ count-vs-fraction)', async () => {
    // A tray of portions under one lid: consuming one leaves the tray open on
    // the container's clock, not back at a sealed unopened window.
    const { pipeline } = harness();
    const { item: oats } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: oats.ulid }],
      derived: {
        name: 'Oat tray',
        shelf_life_class: 'prepared',
        units_total: 4,
        unit_seal: 'shared',
        recipe_ulid: RECIPE.ulid,
      },
      at: '2026-07-17',
    });
    expect(derived.unit_seal).toBe('shared');

    const result = await pipeline.consume(derived.ulid, { ulid: ULID(64), quantity: 2, at: '2026-07-18' });
    expect(result!.item.units_remaining).toBe(2);
    expect(result!.item.state).toBe('open'); // the lid is off
    expect(result!.item.opened_at).toBe('2026-07-18'); // implied by the first depletion
    expect(result!.item.on_hand_fraction).toBe(0.5); // derived from the count
    // Two units of a per-unit recipe, never a share of one.
    expect(result!.entry.calories).toBe(2184);
  });

  it('rejects a derived unit_seal with no units_total', async () => {
    const { pipeline } = harness();
    const { item: oats } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    await expect(
      pipeline.convert({
        sources: [{ item_ulid: oats.ulid }],
        derived: { name: 'Loose batch', shelf_life_class: 'prepared', unit_seal: 'shared' },
        at: '2026-07-17',
      })
    ).rejects.toThrow(ConversionValidationError);
  });

  it('consumes a fraction-modeled derived item: finishes it in one tap, macros scaled by on_hand_fraction', async () => {
    const { pipeline } = harness();
    const { item: quinoa } = await pipeline.createItem({ raw_label: 'Dry quinoa', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: quinoa.ulid, amount: 0.3 }],
      derived: { name: 'Cooked quinoa', shelf_life_class: 'prepared', on_hand_fraction: 1, recipe_ulid: RECIPE.ulid },
      at: '2026-07-17',
    });
    expect(derived.on_hand_fraction).toBe(1);

    const result = await pipeline.consume(derived.ulid, { ulid: ULID(62) });
    expect(result!.entry.calories).toBe(1092); // full recipe total — on_hand_fraction was 1
    expect(result!.item.state).toBe('finished');
    expect(result!.item.on_hand_fraction).toBe(0);
  });

  it('rejects a quantity greater than units_remaining (400-mapped ConsumeValidationError)', async () => {
    const { pipeline } = harness();
    const { item: oats } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: oats.ulid }],
      derived: { name: 'Overnight oats jar', shelf_life_class: 'prepared', units_total: 2, recipe_ulid: RECIPE.ulid },
      at: '2026-07-17',
    });
    await expect(pipeline.consume(derived.ulid, { ulid: ULID(63), quantity: 3 })).rejects.toThrow(ConsumeValidationError);
  });

  it('rejects a non-1 quantity against a fraction-modeled item', async () => {
    const { pipeline } = harness();
    const { item: quinoa } = await pipeline.createItem({ raw_label: 'Dry quinoa', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: quinoa.ulid, amount: 0.3 }],
      derived: { name: 'Cooked quinoa', shelf_life_class: 'prepared', on_hand_fraction: 1, recipe_ulid: RECIPE.ulid },
      at: '2026-07-17',
    });
    await expect(pipeline.consume(derived.ulid, { ulid: ULID(64), quantity: 2 })).rejects.toThrow(ConsumeValidationError);
  });

  it('rejects an item with no recipe-linked derivation (400-mapped ConsumeIneligibleError)', async () => {
    const { pipeline } = harness();
    const { item } = await pipeline.createItem({ raw_label: 'Plain yogurt tub', shelf_life_class: 'fridge_short', acquired_at: '2026-07-01' });
    await expect(pipeline.consume(item.ulid, { ulid: ULID(65) })).rejects.toThrow(ConsumeIneligibleError);
  });

  it('rejects a derived item whose conversion carried no recipe_ulid', async () => {
    const { pipeline } = harness();
    const { item: quinoa } = await pipeline.createItem({ raw_label: 'Dry quinoa', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: quinoa.ulid, amount: 0.3 }],
      derived: { name: 'Cooked quinoa', shelf_life_class: 'prepared', on_hand_fraction: 1 }, // no recipe_ulid
      at: '2026-07-17',
    });
    await expect(pipeline.consume(derived.ulid, { ulid: ULID(66) })).rejects.toThrow(ConsumeIneligibleError);
  });

  it('rejects a recipe_ulid that fails to resolve (unknown recipe)', async () => {
    const { pipeline } = harness([]); // resolveRecipe never finds anything
    const { item: oats } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: oats.ulid }],
      derived: { name: 'Overnight oats jar', shelf_life_class: 'prepared', units_total: 3, recipe_ulid: RECIPE.ulid },
      at: '2026-07-17',
    });
    await expect(pipeline.consume(derived.ulid, { ulid: ULID(67) })).rejects.toThrow(ConsumeIneligibleError);
  });

  it('rejects an already-terminal item (409-mapped InvalidTransitionError), even before eligibility is checked', async () => {
    const { pipeline } = harness();
    const { item } = await pipeline.createItem({ raw_label: 'Old milk', shelf_life_class: 'fridge_short', acquired_at: '2026-07-01' });
    await pipeline.applyEvent(item.ulid, 'finished', {});
    await expect(pipeline.consume(item.ulid, { ulid: ULID(68) })).rejects.toThrow(InvalidTransitionError);
  });

  it('404s (returns null) for an unknown item', async () => {
    const { pipeline } = harness();
    const result = await pipeline.consume(ULID(99), { ulid: ULID(69) });
    expect(result).toBeNull();
  });

  it('503s (ConsumeNotConfiguredError) when the pipeline has no consumeStore/resolveRecipe wired', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log); // no consume config
    const { item } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    await expect(pipeline.consume(item.ulid, { ulid: ULID(70) })).rejects.toThrow(ConsumeNotConfiguredError);
  });

  it('idempotent replay: succeeds with no duplicate entry and no double-deplete, even after the item went terminal', async () => {
    const { pipeline, entries } = harness();
    const { item: oats } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: oats.ulid }],
      derived: { name: 'Overnight oats jar', shelf_life_class: 'prepared', units_total: 1, recipe_ulid: RECIPE.ulid },
      at: '2026-07-17',
    });

    const first = await pipeline.consume(derived.ulid, { ulid: ULID(71) });
    expect(first!.created).toBe(true);
    expect(first!.item.state).toBe('finished'); // the only unit — the item is now terminal

    // A replay of the SAME client-generated entry ulid must still succeed
    // (the offline app retries on every reconnect) rather than 409 against
    // the terminal state the first attempt itself produced.
    const replay = await pipeline.consume(derived.ulid, { ulid: ULID(71) });
    expect(replay!.created).toBe(false);
    expect(replay!.entry).toEqual(first!.entry);
    expect(replay!.item.state).toBe('finished');
    expect(replay!.item.units_remaining).toBe(0);

    expect(entries.records.size).toBe(1); // no duplicate entry
  });
});

describe('reconcile (§ Reconcile — corrections are observations, not events)', () => {
  it('recounts an open fraction item without touching opened_at or eat_by', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({ raw_label: 'Soymilk', shelf_life_class: 'fridge_short', acquired_at: '2026-07-17' });
    await pipeline.applyEvent(item.ulid, 'opened', { at: '2026-07-19', fraction: 0.34 });

    const fixed = await pipeline.reconcileItem(item.ulid, { on_hand_fraction: 0.75 });
    expect(fixed!.on_hand_fraction).toBe(0.75);
    expect(fixed!.state).toBe('open');
    expect(fixed!.opened_at).toBe('2026-07-19'); // clock untouched
    expect(fixed!.eat_by).toBe('2026-07-26'); // opened 7/19 + fridge_short 7 — unchanged
    expect(fixed!.notes).toContain('reconciled');
    expect(fixed!.notes).toContain('0.34→0.75');
  });

  it('corrects a mis-opened item back to stocked: opened_at clears, eat_by re-derives from the unopened window + product overrides (egg-carton regression)', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const eggs = await store.insertProduct({
      ulid: ULID(80), name: 'Omega-3 Eggs', shelf_life_class: 'fridge_long', aliases: [],
      nutrition_per_100g: null, ingredients: null, package_size: 'dozen',
      shelf_life_days_unopened: 30, shelf_life_days_opened: 30,
    });
    const { item } = await pipeline.createItem({ product_ulid: eggs.ulid, shelf_life_class: 'fridge_long', acquired_at: '2026-07-17' });
    // The bad correction workaround: 'opened --fraction 1' on a sealed carton.
    const corrupted = await pipeline.applyEvent(item.ulid, 'opened', { at: '2026-07-21', fraction: 1 });
    expect(corrupted!.state).toBe('open');
    expect(corrupted!.eat_by).toBe('2026-08-20'); // opened 7/21 + product opened override 30

    const fixed = await pipeline.reconcileItem(item.ulid, { state: 'stocked', notes: 'carton never actually opened' });
    expect(fixed!.state).toBe('stocked');
    expect(fixed!.opened_at).toBeNull(); // stocked means sealed — auto-cleared
    expect(fixed!.eat_by).toBe('2026-08-16'); // acquired 7/17 + unopened override 30
    expect(fixed!.notes).toContain('carton never actually opened');
  });

  it('reclassifies fraction→counted (the salmon port), supports finished-unit after, and reverts', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({ raw_label: 'Salmon 3-pack', shelf_life_class: 'pantry', acquired_at: '2026-07-17' });
    await pipeline.applyEvent(item.ulid, 'opened', { at: '2026-07-18', fraction: 0.67 });

    const counted = await pipeline.reconcileItem(item.ulid, { units_total: 3, units_remaining: 2, state: 'stocked' });
    expect(counted!.units_total).toBe(3);
    expect(counted!.units_remaining).toBe(2);
    expect(counted!.state).toBe('stocked');
    expect(counted!.opened_at).toBeNull();
    expect(counted!.eat_by).toBe('2027-07-17'); // sealed pantry window off acquired_at

    const afterUnit = await pipeline.applyEvent(item.ulid, 'finished-unit', {});
    expect(afterUnit!.units_remaining).toBe(1);
    expect(afterUnit!.state).toBe('stocked');

    const reverted = await pipeline.reconcileItem(item.ulid, { units_total: null, on_hand_fraction: 0.33 });
    expect(reverted!.units_total).toBeNull();
    expect(reverted!.units_remaining).toBeNull();
    expect(reverted!.on_hand_fraction).toBe(0.33);
  });

  it('rejects zero quantities, terminal items without an explicit state, and contradictions', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({ raw_label: 'Yogurt', shelf_life_class: 'fridge_short', acquired_at: '2026-07-17' });

    await expect(pipeline.reconcileItem(item.ulid, { on_hand_fraction: 0 })).rejects.toThrow(ReconcileValidationError);
    await expect(pipeline.reconcileItem(item.ulid, {})).rejects.toThrow(ReconcileValidationError);
    // stocked cannot carry an opened_at.
    await expect(pipeline.reconcileItem(item.ulid, { state: 'stocked', opened_at: '2026-07-19' })).rejects.toThrow(ReconcileValidationError);
    // units_remaining on a fraction-modeled item.
    await expect(pipeline.reconcileItem(item.ulid, { units_remaining: 2 })).rejects.toThrow(NotCountedItemError);
    // open requires a clock.
    await expect(pipeline.reconcileItem(item.ulid, { state: 'open', on_hand_fraction: 0.5 })).rejects.toThrow(ReconcileValidationError);

    await pipeline.applyEvent(item.ulid, 'finished', { at: '2026-07-20' });
    await expect(pipeline.reconcileItem(item.ulid, { on_hand_fraction: 0.5 })).rejects.toThrow(ReconcileValidationError);
  });

  it('resurrects a mis-finished item with an explicit state (closed_at clears)', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({ raw_label: 'Feta', shelf_life_class: 'fridge_short', acquired_at: '2026-07-17' });
    await pipeline.applyEvent(item.ulid, 'opened', { at: '2026-07-18' });
    await pipeline.applyEvent(item.ulid, 'finished', { at: '2026-07-20' });

    const back = await pipeline.reconcileItem(item.ulid, { state: 'open', opened_at: '2026-07-18', on_hand_fraction: 0.4 });
    expect(back!.state).toBe('open');
    expect(back!.closed_at).toBeNull();
    expect(back!.on_hand_fraction).toBe(0.4);
    expect(back!.eat_by).toBe('2026-07-25'); // opened 7/18 + fridge_short 7
  });

  it('remark recount routes to reconcile — fraction corrected, no clock stamped', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const { item } = await pipeline.createItem({ raw_label: 'Soymilk', shelf_life_class: 'fridge_short', acquired_at: '2026-07-17' });
    await pipeline.applyEvent(item.ulid, 'opened', { at: '2026-07-19', fraction: 0.34 });

    const res = await pipeline.resolveRemark('the soymilk is actually 75% full');
    expect(res.matched).toBe(true);
    expect(res.event?.type).toBe('recount');
    expect(res.item?.on_hand_fraction).toBe(0.75);
    expect(res.item?.opened_at).toBe('2026-07-19'); // untouched
    expect(res.item?.state).toBe('open');
  });

  describe('reaches every field an observation can settle', () => {
    it('corrects the shelf-life class against the EXISTING anchor, and never re-anchors', async () => {
      const store = new MemoryInventoryStore();
      const pipeline = new InventoryPipeline(store, null, null, log);
      const { item } = await pipeline.createItem({
        raw_label: 'Bagged Greens',
        shelf_life_class: 'fridge_long', // recorded wrong from the start
        acquired_at: '2026-07-01',
      });
      expect(item.eat_by).toBe('2026-08-30'); // 60 d

      const fixed = await pipeline.reconcileItem(item.ulid, { shelf_life_class: 'produce' });
      expect(fixed!.shelf_life_class).toBe('produce');
      // 7 d from ACQUISITION — "it was always produce", not "it became produce
      // today". A storage move would have anchored at today instead.
      expect(fixed!.eat_by).toBe('2026-07-08');
      expect(fixed!.storage_moved_at).toBeNull();
      expect(fixed!.notes).toContain('shelf_life_class fridge_long→produce');
    });

    it('a class correction leaves an existing storage-move anchor standing', async () => {
      const store = new MemoryInventoryStore();
      const pipeline = new InventoryPipeline(store, null, null, log);
      const { item } = await pipeline.createItem({
        raw_label: 'Vacuum Pack',
        shelf_life_class: 'frozen',
        acquired_at: '2026-07-01',
      });
      await pipeline.applyEvent(item.ulid, 'moved', { to: 'fridge_long', at: '2026-07-09' });
      // The move happened; only which class it moved INTO was wrong.
      const fixed = await pipeline.reconcileItem(item.ulid, { shelf_life_class: 'fridge_short' });
      expect(fixed!.storage_moved_at).toBe('2026-07-09');
      expect(fixed!.eat_by).toBe('2026-07-23'); // 14 d from the move, not from acquisition
    });

    it('clears and re-queues needs_info without a label scan', async () => {
      const store = new MemoryInventoryStore();
      const pipeline = new InventoryPipeline(store, null, null, log);
      // A spice jar: no Nutrition Facts panel exists, so a rescan can never
      // clear the flag — the owner simply knows what it is.
      const { item } = await pipeline.createItem({ raw_label: 'UNLABELED JAR', needs_info: true });
      expect(item.needs_info).toBe(true);

      const known = await pipeline.reconcileItem(item.ulid, { needs_info: false });
      expect(known!.needs_info).toBe(false);
      expect(await pipeline.listQuestions()).toEqual([]);
      expect(known!.notes).toContain('needs_info true→false');

      const requeued = await pipeline.reconcileItem(item.ulid, { needs_info: true });
      expect(requeued!.needs_info).toBe(true);
      expect((await pipeline.listQuestions()).length).toBe(1);
    });

    it('relinks product_ulid, clearing needs_info and folding in the product’s day overrides', async () => {
      const store = new MemoryInventoryStore();
      const product = await store.insertProduct({
        ulid: ULID(200),
        name: 'Cultured Yogurt',
        shelf_life_class: 'fridge_long',
        aliases: [],
        nutrition_per_100g: null,
        ingredients: null,
        package_size: null,
        shelf_life_days_unopened: 30,
        shelf_life_days_opened: 10,
      });
      const pipeline = new InventoryPipeline(store, null, null, log);
      const { item } = await pipeline.createItem({ raw_label: 'UNKNOWN LINE', needs_info: true, acquired_at: '2026-07-01' });
      expect(item.eat_by).toBeNull(); // no class yet, so honestly no clock

      const linked = await pipeline.reconcileItem(item.ulid, { product_ulid: product.ulid });
      expect(linked!.product_ulid).toBe(product.ulid);
      expect(linked!.needs_info).toBe(false); // the identity question is answered
      expect(linked!.shelf_life_class).toBe('fridge_long'); // adopted (the item had none)
      expect(linked!.eat_by).toBe('2026-07-31'); // the PRODUCT's 30-day override, not the class default
      expect(linked!.notes).toContain(`product_ulid null→${product.ulid}`);
    });

    it('never overwrites an item’s own class when linking a product, and can unlink', async () => {
      const store = new MemoryInventoryStore();
      const product = await store.insertProduct({
        ulid: ULID(201),
        name: 'Deli Turkey',
        shelf_life_class: 'fridge_long',
        aliases: [],
        nutrition_per_100g: null,
        ingredients: null,
        package_size: null,
        shelf_life_days_unopened: null,
        shelf_life_days_opened: null,
      });
      const pipeline = new InventoryPipeline(store, null, null, log);
      const { item } = await pipeline.createItem({
        raw_label: 'TURKEY',
        shelf_life_class: 'fridge_short',
        acquired_at: '2026-07-01',
      });
      const linked = await pipeline.reconcileItem(item.ulid, { product_ulid: product.ulid });
      expect(linked!.shelf_life_class).toBe('fridge_short'); // the item's own snapshot wins
      expect(linked!.eat_by).toBe('2026-07-15');

      const unlinked = await pipeline.reconcileItem(item.ulid, { product_ulid: null });
      expect(unlinked!.product_ulid).toBeNull();
      expect(unlinked!.needs_info).toBe(false); // unlinking is not a re-queue on its own
    });

    it('refuses an unknown product, and an archived one — naming the survivor when it was merged', async () => {
      const store = new MemoryInventoryStore();
      const loser = await store.insertProduct({
        ulid: ULID(202),
        name: 'Duplicate Yogurt',
        shelf_life_class: 'fridge_long',
        aliases: [],
        nutrition_per_100g: null,
        ingredients: null,
        package_size: null,
        shelf_life_days_unopened: null,
        shelf_life_days_opened: null,
      });
      const survivorUlid = ULID(203);
      await store.insertProduct({
        ulid: survivorUlid,
        name: 'Yogurt',
        shelf_life_class: 'fridge_long',
        aliases: [],
        nutrition_per_100g: null,
        ingredients: null,
        package_size: null,
        shelf_life_days_unopened: null,
        shelf_life_days_opened: null,
      });
      await store.archiveProduct(loser.ulid, survivorUlid);

      const pipeline = new InventoryPipeline(store, null, null, log);
      const { item } = await pipeline.createItem({ raw_label: 'YOGURT', acquired_at: '2026-07-01' });
      await expect(pipeline.reconcileItem(item.ulid, { product_ulid: ULID(204) })).rejects.toThrow(
        ReconcileValidationError
      );
      await expect(
        pipeline.reconcileItem(item.ulid, { product_ulid: loser.ulid })
      ).rejects.toThrow(survivorUlid);
    });

    it('a needs_info item created WITH a class still gets a clock (§ Shelf-life classes)', async () => {
      const store = new MemoryInventoryStore();
      const pipeline = new InventoryPipeline(store, null, null, log);
      // The observed failure: correctly-classed produce seeded with needs_info
      // only because the BRAND was unconfirmed came back eat_by: null and sat
      // invisible to eat-first. Not knowing what something is has nothing to do
      // with how fast it rots — and an unidentified perishable is the one most
      // worth a clock.
      const { item } = await pipeline.createItem({
        raw_label: 'BAGGED GREENS',
        shelf_life_class: 'produce',
        acquired_at: '2026-07-01',
        needs_info: true,
      });
      expect(item.needs_info).toBe(true);
      expect(item.eat_by).toBe('2026-07-08');
      // …so it participates in eat-first ordering like anything else.
      expect((await pipeline.listInventory({})).map((i) => i.eat_by)).toEqual(['2026-07-08']);
      // It is still an open question, though — the two facts stay separate.
      expect((await pipeline.listQuestions()).length).toBe(1);
    });

    it('an item with no class at all still has no clock — `unknown` is the honest null', async () => {
      const store = new MemoryInventoryStore();
      const pipeline = new InventoryPipeline(store, null, null, log);
      const { item } = await pipeline.createItem({ raw_label: 'MYSTERY LINE', needs_info: true, acquired_at: '2026-07-01' });
      expect(item.eat_by).toBeNull();
    });
  });
});

describe('receipt prices (§ Prices — capture as printed)', () => {
  it('a parsed batch lands line price_cents + batch total_cents; multibuy fan-out never divides the printed line total', async () => {
    const store = new MemoryInventoryStore();
    const parser = new FakeReceiptParser({
      store: 'Example Grocer',
      total_cents: 2493,
      lines: [
        { text: 'FETA CHEESE', price_cents: 599 },
        // Multibuy: 3 sausages, printed line total 1497 — stays the LINE's
        // price; the 3 fanned-out items don't divide or duplicate it.
        { text: 'ITAL CHICKEN SAUSAGE', quantity: 3, price_cents: 1497 },
        { text: 'MYSTERY', price_cents: null },
      ],
    });
    const pipeline = new InventoryPipeline(store, parser, null, log);
    await pipeline.ingestReceipt({ ulid: ULID(90), store: 'Example Grocer', purchased_at: '2026-07-22' }, [photo]);
    await pipeline.settle();

    const view = await pipeline.getBatchView(ULID(90));
    expect(view!.batch.total_cents).toBe(2493);
    const byText = new Map(view!.lines.map((l) => [l.raw_text, l]));
    expect(byText.get('FETA CHEESE')!.price_cents).toBe(599);
    expect(byText.get('ITAL CHICKEN SAUSAGE')!.price_cents).toBe(1497);
    expect(byText.get('ITAL CHICKEN SAUSAGE')!.quantity).toBe(3);
    expect(byText.get('MYSTERY')!.price_cents).toBeNull(); // unreadable stays null, never 0

    const items = await pipeline.listInventory({});
    expect(items.length).toBe(5); // 1 + 3 + 1 fan-out unaffected
  });
});

describe('price history (§ Price history)', () => {
  /** Seed a purchase of `productUlid` at a store on a date, priced as printed. */
  async function purchase(
    store: MemoryInventoryStore,
    opts: {
      n: number;
      product_ulid: string;
      store_name: string | null;
      purchased_at: string;
      raw_text: string;
      price_cents: number | null;
      quantity?: number;
      item_ulid?: string | null;
    }
  ) {
    const batch = await store.insertBatchIfAbsent({
      ulid: ULID(opts.n),
      source: 'receipt',
      store: opts.store_name,
      purchased_at: new Date(opts.purchased_at),
    });
    return store.insertLine({
      ulid: ULID(opts.n + 1),
      batch_ulid: batch.record.ulid,
      raw_text: opts.raw_text,
      quantity: opts.quantity ?? 1,
      price_cents: opts.price_cents,
      match_outcome: 'matched',
      product_ulid: opts.product_ulid,
      inventory_item_ulid: opts.item_ulid ?? null,
    });
  }

  async function seedProduct(store: MemoryInventoryStore, n: number, name: string, extra = {}) {
    return store.insertProduct({
      ulid: ULID(n),
      name,
      shelf_life_class: 'pantry',
      aliases: [],
      nutrition_per_100g: null,
      ingredients: null,
      package_size: null,
      shelf_life_days_unopened: null,
      shelf_life_days_opened: null,
      ...extra,
    });
  }

  it('normalizes a store-brand item bought at three different package sizes, newest first', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const product = await seedProduct(store, 200, 'Store-brand rolled oats');
    await purchase(store, { n: 210, product_ulid: product.ulid, store_name: 'Grocer A', purchased_at: '2026-05-02', raw_text: 'ROLLED OATS 12 OZ', price_cents: 349 });
    await purchase(store, { n: 220, product_ulid: product.ulid, store_name: 'Grocer B', purchased_at: '2026-06-02', raw_text: 'ROLLED OATS 16 OZ', price_cents: 399 });
    await purchase(store, { n: 230, product_ulid: product.ulid, store_name: 'Grocer A', purchased_at: '2026-07-02', raw_text: 'ROLLED OATS 42 OZ', price_cents: 799 });

    const history = await pipeline.priceHistory(product.ulid);
    expect(history!.product_name).toBe('Store-brand rolled oats');
    expect(history!.count).toBe(3);
    expect(history!.points.map((p) => p.purchased_at)).toEqual(['2026-07-02', '2026-06-02', '2026-05-02']);
    // Every point normalized off its OWN package size, so the per-100g series
    // is comparable even though no two packages match.
    expect(history!.points.every((p) => p.unit_basis === 'line')).toBe(true);
    const per100 = history!.points.map((p) => p.cents_per_100g!);
    expect(per100[0]).toBeLessThan(per100[1]!); // the 42 oz is the cheapest per gram
    expect(per100[1]).toBeLessThan(per100[2]!);
  });

  it('falls back to the lexicon package size the store recorded, per store', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const product = await seedProduct(store, 240, 'Store-brand yogurt');
    // The line text carries no size; the lexicon mapping for that store does.
    await store.upsertLexicon({
      ulid: ULID(241),
      store: 'Grocer A',
      line_text: 'PLAIN YOGURT',
      product_ulid: product.ulid,
      package_size: '32 oz',
      shelf_life_class: 'fridge_short',
    });
    await purchase(store, { n: 250, product_ulid: product.ulid, store_name: 'Grocer A', purchased_at: '2026-07-02', raw_text: 'PLAIN YOGURT', price_cents: 449 });
    await purchase(store, { n: 260, product_ulid: product.ulid, store_name: 'Grocer B', purchased_at: '2026-07-03', raw_text: 'PLAIN YOGURT', price_cents: 499 });

    const history = await pipeline.priceHistory(product.ulid);
    const byStore = new Map(history!.points.map((p) => [p.store, p]));
    expect(byStore.get('Grocer A')!.unit_basis).toBe('lexicon');
    expect(byStore.get('Grocer A')!.cents_per_100g).toBeCloseTo(49.47, 1);
    // Grocer B has no mapping and the product carries no size — honestly null.
    expect(byStore.get('Grocer B')!.unit_basis).toBeNull();
    expect(byStore.get('Grocer B')!.cents_per_100g).toBeNull();
    expect(byStore.get('Grocer B')!.price_cents).toBe(499);
  });

  it('scopes to one store on request', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const product = await seedProduct(store, 270, 'Store-brand rice');
    await purchase(store, { n: 280, product_ulid: product.ulid, store_name: 'Grocer A', purchased_at: '2026-07-02', raw_text: 'RICE 2 LB', price_cents: 299 });
    await purchase(store, { n: 290, product_ulid: product.ulid, store_name: 'Grocer B', purchased_at: '2026-07-03', raw_text: 'RICE 2 LB', price_cents: 349 });

    const scoped = await pipeline.priceHistory(product.ulid, { store: 'Grocer B' });
    expect(scoped!.count).toBe(1);
    expect(scoped!.points[0]!.price_cents).toBe(349);
  });

  it('unions both records’ purchases after a product merge, and empties the loser', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    // Two records for one real product — the duplicate the merge path exists for.
    const survivor = await seedProduct(store, 300, 'Store-brand oat milk', { package_size: '64 fl oz' });
    const loser = await seedProduct(store, 310, 'OAT MILK 64OZ', { package_size: '64 fl oz' });
    await purchase(store, { n: 320, product_ulid: survivor.ulid, store_name: 'Grocer A', purchased_at: '2026-06-02', raw_text: 'OAT MILK', price_cents: 429 });
    await purchase(store, { n: 330, product_ulid: loser.ulid, store_name: 'Grocer A', purchased_at: '2026-07-02', raw_text: 'OAT MILK', price_cents: 459 });

    expect((await pipeline.priceHistory(survivor.ulid))!.count).toBe(1);
    const merge = await pipeline.mergeProducts(loser.ulid, survivor.ulid);
    expect(merge!.relinked.batch_lines).toBe(1);

    // The merge relinks purchase_batch_lines.product_ulid, which is exactly the
    // column this read keys on — so the union needs no history-specific step.
    const merged = await pipeline.priceHistory(survivor.ulid);
    expect(merged!.count).toBe(2);
    expect(merged!.points.map((p) => p.price_cents)).toEqual([459, 429]);
    expect(merged!.points.every((p) => p.unit_basis === 'product_net_content' || p.unit_basis === 'product_package_size')).toBe(true);

    // The retired loser still resolves by ULID (history must survive
    // retirement) and honestly reads empty — its lines moved.
    const loserHistory = await pipeline.priceHistory(loser.ulid);
    expect(loserHistory).not.toBeNull();
    expect(loserHistory!.count).toBe(0);
  });

  it('is null for an unknown product', async () => {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    expect(await pipeline.priceHistory(ULID(399))).toBeNull();
  });

  it('reads prices a real receipt parse recorded, with no seeding of its own', async () => {
    const store = new MemoryInventoryStore();
    const product = await seedProduct(store, 340, 'Store-brand black beans');
    await store.upsertLexicon({
      ulid: ULID(341),
      store: 'Example Grocer',
      line_text: 'BLACK BEANS 15 OZ',
      product_ulid: product.ulid,
      package_size: '15 oz',
      shelf_life_class: 'pantry',
    });
    const parser = new FakeReceiptParser({
      store: 'Example Grocer',
      total_cents: 356,
      lines: [{ text: 'BLACK BEANS 15 OZ', quantity: 2, price_cents: 356 }],
    });
    const pipeline = new InventoryPipeline(store, parser, null, log);
    await pipeline.ingestReceipt({ ulid: ULID(350), purchased_at: '2026-07-22' }, [photo]);
    await pipeline.settle();

    const history = await pipeline.priceHistory(product.ulid);
    expect(history!.count).toBe(1);
    const point = history!.points[0]!;
    expect(point.price_cents).toBe(356);
    expect(point.quantity).toBe(2);
    expect(point.package_price_cents).toBe(178); // per can, a read-time division
    expect(point.cents_per_100g).toBeCloseTo(41.86, 1);
  });
});

describe('waste costing (§ Waste costing)', () => {
  async function harness() {
    const store = new MemoryInventoryStore();
    const pipeline = new InventoryPipeline(store, null, null, log);
    const product = await store.insertProduct({
      ulid: ULID(400),
      name: 'Store-brand greens',
      shelf_life_class: 'produce',
      aliases: [],
      nutrition_per_100g: null,
      ingredients: null,
      package_size: null,
      shelf_life_days_unopened: null,
      shelf_life_days_opened: null,
    });
    return { store, pipeline, product };
  }

  /** A priced receipt line, optionally naming the item it created. */
  async function pricedBatch(
    store: MemoryInventoryStore,
    opts: { n: number; product_ulid: string; purchased_at: string; price_cents: number | null; item_ulid?: string; quantity?: number }
  ) {
    const batch = await store.insertBatchIfAbsent({
      ulid: ULID(opts.n),
      source: 'receipt',
      store: 'Example Grocer',
      purchased_at: new Date(opts.purchased_at),
    });
    const line = await store.insertLine({
      ulid: ULID(opts.n + 1),
      batch_ulid: batch.record.ulid,
      raw_text: 'MIXED GREENS 5 OZ',
      quantity: opts.quantity ?? 1,
      price_cents: opts.price_cents,
      match_outcome: 'matched',
      product_ulid: opts.product_ulid,
      inventory_item_ulid: opts.item_ulid ?? null,
    });
    return { batch: batch.record, line };
  }

  it('costs a partial toss by the fraction discarded, off the item’s OWN receipt line', async () => {
    const { store, pipeline, product } = await harness();
    const { batch } = await pricedBatch(store, { n: 410, product_ulid: product.ulid, purchased_at: '2026-07-18', price_cents: 499 });
    const { item } = await pipeline.createItem({
      product_ulid: product.ulid,
      batch_ulid: batch.ulid,
      store: 'Example Grocer',
      acquired_at: '2026-07-18',
    });
    // A quarter goes in the bin; the item stays alive (directional).
    await pipeline.applyEvent(item.ulid, 'tossed', { fraction: 0.25, at: '2026-07-21' });

    const report = await pipeline.wasteReport();
    expect(report.count).toBe(1);
    const row = report.waste[0]!;
    expect(row.product_name).toBe('Store-brand greens');
    expect(row.tossed_at).toBe('2026-07-21');
    expect(row.amount_fraction).toBe(0.25);
    expect(row.terminal).toBe(false);
    expect(row.cost_basis).toBe('batch_line');
    expect(row.cost_cents).toBeCloseTo(124.75, 2); // a quarter of 499¢, not 499¢
    expect(row.priced_at).toBe('2026-07-18');
    expect(report.totals).toEqual({ rows: 1, cost_cents: 124.75, cost_unknown_rows: 0 });
  });

  it('costs a counted item’s toss by the SEALED UNITS discarded, not the whole pack', async () => {
    const { store, pipeline, product } = await harness();
    const { batch } = await pricedBatch(store, { n: 420, product_ulid: product.ulid, purchased_at: '2026-07-01', price_cents: 1200 });
    const { item } = await pipeline.createItem({
      product_ulid: product.ulid,
      batch_ulid: batch.ulid,
      acquired_at: '2026-07-01',
      units_total: 12,
    });
    // Ten units were eaten one at a time; the last two spoiled and were tossed.
    for (let i = 0; i < 10; i++) {
      await pipeline.applyEvent(item.ulid, 'finished-unit', { at: '2026-07-05' });
    }
    const tossed = await pipeline.applyEvent(item.ulid, 'tossed', { at: '2026-07-10' });
    expect(tossed!.state).toBe('tossed');
    // on_hand_fraction is still 1.0 on a counted item — the note's unit count is
    // what keeps the cost honest.
    expect(tossed!.notes).toContain('tossed 1 (2u) 2026-07-10');

    const report = await pipeline.wasteReport();
    const row = report.waste[0]!;
    expect(row.units).toBe(2);
    expect(row.cost_cents).toBe(200); // two twelfths of 1200¢
    expect(row.terminal).toBe(true);
  });

  it('reads an item with no priced purchase as UNKNOWN cost, never zero', async () => {
    const { pipeline } = await harness();
    // A manually-seeded item: no batch, no receipt, no price anywhere.
    const { item } = await pipeline.createItem({ raw_label: 'Leftover soup', shelf_life_class: 'prepared', acquired_at: '2026-07-19' });
    await pipeline.applyEvent(item.ulid, 'tossed', { at: '2026-07-24' });

    const report = await pipeline.wasteReport();
    expect(report.count).toBe(1);
    const row = report.waste[0]!;
    expect(row.product_name).toBe('Leftover soup');
    expect(row.cost_cents).toBeNull();
    expect(row.cost_basis).toBe('unknown');
    expect(row.price_line_ulid).toBeNull();
    // The total does NOT absorb the unknown row as a zero — it says how partial
    // it is (§ Waste costing).
    expect(report.totals).toEqual({ rows: 1, cost_cents: 0, cost_unknown_rows: 1 });
  });

  it('falls back to the product’s nearest priced purchase when the item’s own line is unpriced', async () => {
    const { store, pipeline, product } = await harness();
    // An earlier purchase carried a price; the item's own line did not.
    await pricedBatch(store, { n: 430, product_ulid: product.ulid, purchased_at: '2026-06-10', price_cents: 449 });
    const { batch } = await pricedBatch(store, { n: 440, product_ulid: product.ulid, purchased_at: '2026-07-18', price_cents: null });
    const { item } = await pipeline.createItem({
      product_ulid: product.ulid,
      batch_ulid: batch.ulid,
      acquired_at: '2026-07-18',
    });
    await pipeline.applyEvent(item.ulid, 'tossed', { at: '2026-07-22' });

    const row = (await pipeline.wasteReport()).waste[0]!;
    expect(row.cost_basis).toBe('product_price');
    expect(row.cost_cents).toBe(449);
    expect(row.priced_at).toBe('2026-06-10');
  });

  it('excludes a mistakenly-tossed duplicate that was merged away — structured state, not the note', async () => {
    const { store, pipeline, product } = await harness();
    const { batch } = await pricedBatch(store, { n: 450, product_ulid: product.ulid, purchased_at: '2026-07-18', price_cents: 500 });
    const { item: survivor } = await pipeline.createItem({ product_ulid: product.ulid, batch_ulid: batch.ulid, acquired_at: '2026-07-18' });
    const { item: duplicate } = await pipeline.createItem({ product_ulid: product.ulid, batch_ulid: batch.ulid, acquired_at: '2026-07-19' });

    // The duplicate was closed out as `tossed` before anyone noticed it was a
    // duplicate — a claim about food that never existed.
    await pipeline.applyEvent(duplicate.ulid, 'tossed', { at: '2026-07-20' });
    expect((await pipeline.wasteReport()).count).toBe(1);

    // Merging it away retracts its state; the stale `tossed …` note stays in
    // the notes, but the read gates on state, so the waste goes with it.
    const merge = await pipeline.mergeItems(duplicate.ulid, survivor.ulid);
    expect(merge!.merged.state).toBe('dismissed');
    expect(merge!.merged.notes).toContain('tossed');
    const report = await pipeline.wasteReport();
    expect(report.count).toBe(0);
    expect(report.totals).toEqual({ rows: 0, cost_cents: 0, cost_unknown_rows: 0 });
  });

  it('reports every toss on an item, newest first, and windows by toss date', async () => {
    const { store, pipeline, product } = await harness();
    const { batch } = await pricedBatch(store, { n: 460, product_ulid: product.ulid, purchased_at: '2026-07-01', price_cents: 800 });
    const { item } = await pipeline.createItem({ product_ulid: product.ulid, batch_ulid: batch.ulid, acquired_at: '2026-07-01' });
    await pipeline.applyEvent(item.ulid, 'tossed', { fraction: 0.25, at: '2026-07-05' });
    await pipeline.applyEvent(item.ulid, 'tossed', { fraction: 0.25, at: '2026-07-09' });

    const all = await pipeline.wasteReport();
    expect(all.waste.map((r) => r.tossed_at)).toEqual(['2026-07-09', '2026-07-05']);
    expect(all.totals.cost_cents).toBe(400); // two quarters of 800¢
    // Neither partial closed the item, so neither is terminal.
    expect(all.waste.every((r) => r.terminal === false)).toBe(true);

    const windowed = await pipeline.wasteReport({ since: '2026-07-07' });
    expect(windowed.count).toBe(1);
    expect(windowed.waste[0]!.tossed_at).toBe('2026-07-09');
    expect((await pipeline.wasteReport({ until: '2026-07-06' })).count).toBe(1);
  });

  it('never counts a dismissal or a finish as waste', async () => {
    const { pipeline } = await harness();
    const { item: housewares } = await pipeline.createItem({ raw_label: 'SOUP MUG', store: 'Example Grocer', needs_info: true, acquired_at: '2026-07-18' });
    await pipeline.dismissItem(housewares.ulid, { nonInventory: true });
    const { item: eaten } = await pipeline.createItem({ raw_label: 'Rice', shelf_life_class: 'pantry', acquired_at: '2026-07-18' });
    await pipeline.applyEvent(eaten.ulid, 'finished', { at: '2026-07-20' });

    expect((await pipeline.wasteReport()).count).toBe(0);
  });
});
