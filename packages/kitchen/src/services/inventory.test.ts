import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { MemoryInventoryStore } from '../inventory-memory-store.js';
import { MemoryEntryStore } from '../memory-store.js';
import { MemoryConsumeStore } from './consume-memory-store.js';
import {
  ConsumeIneligibleError,
  ConsumeNotConfiguredError,
  ConsumeValidationError,
  ConversionValidationError,
  InventoryPipeline,
  NotCountedItemError,
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
  constructor(private result: ParsedLabel) {}
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
    nutrition_per_100g: null,
    ingredients: null,
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
    expect(item!.on_hand_fraction).toBe(1); // present but unused for a counted item
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
      derived: { name: 'Hard-boiled eggs', shelf_life_class: 'fridge_short', units_total: 6 },
      at: '2026-07-10',
    });

    expect(result.sources.length).toBe(1);
    expect(result.sources[0]!.units_remaining).toBe(6); // 12 - 6
    expect(result.sources[0]!.state).toBe('stocked'); // still alive, half the pack left

    expect(result.derived.raw_label).toBe('Hard-boiled eggs');
    expect(result.derived.units_total).toBe(6);
    expect(result.derived.units_remaining).toBe(6);
    expect(result.derived.eat_by).toBe('2026-07-24'); // fridge_short unopened 14 days from 07-10
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
      derived: { name: 'Cooked quinoa', shelf_life_class: 'fridge_short', on_hand_fraction: 1, recipe_ulid: null },
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
      derived: { name: 'More cooked quinoa', shelf_life_class: 'fridge_short' },
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
      derived: { name: 'Overnight oats jar', shelf_life_class: 'fridge_short', units_total: 3, recipe_ulid: RECIPE.ulid },
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
    // Exactly 1/3 of the recipe's deterministic totals — no model call.
    expect(result!.entry.calories).toBe(364); // 1092 / 3
    expect(result!.entry.protein_g).toBe(20.4); // 61.2 / 3
    expect(result!.entry.sat_fat_g).toBe(1.2); // round1(3.48 / 3)
    expect(result!.entry.confidence).toBe(1);

    // Depletion: integer decrement, item stays alive (finished-unit semantics).
    expect(result!.item.units_remaining).toBe(2);
    expect(result!.item.state).toBe('stocked');
    expect(result!.item.opened_at).toBeNull();

    // The entry is really in the store, not just the returned snapshot.
    expect(entries.records.get(ULID(60))?.inventory_item_ulid).toBe(derived.ulid);
  });

  it('the third and final unit consumed finishes the item (units_remaining reaches 0)', async () => {
    const { pipeline } = harness();
    const { item: oats } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: oats.ulid }],
      derived: { name: 'Overnight oats jar', shelf_life_class: 'fridge_short', units_total: 1, recipe_ulid: RECIPE.ulid },
      at: '2026-07-17',
    });

    const result = await pipeline.consume(derived.ulid, { ulid: ULID(61) });
    expect(result!.item.state).toBe('finished');
    expect(result!.item.units_remaining).toBe(0);
    expect(result!.item.on_hand_fraction).toBe(0);
  });

  it('consumes a fraction-modeled derived item: finishes it in one tap, macros scaled by on_hand_fraction', async () => {
    const { pipeline } = harness();
    const { item: quinoa } = await pipeline.createItem({ raw_label: 'Dry quinoa', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: quinoa.ulid, amount: 0.3 }],
      derived: { name: 'Cooked quinoa', shelf_life_class: 'fridge_short', on_hand_fraction: 1, recipe_ulid: RECIPE.ulid },
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
      derived: { name: 'Overnight oats jar', shelf_life_class: 'fridge_short', units_total: 2, recipe_ulid: RECIPE.ulid },
      at: '2026-07-17',
    });
    await expect(pipeline.consume(derived.ulid, { ulid: ULID(63), quantity: 3 })).rejects.toThrow(ConsumeValidationError);
  });

  it('rejects a non-1 quantity against a fraction-modeled item', async () => {
    const { pipeline } = harness();
    const { item: quinoa } = await pipeline.createItem({ raw_label: 'Dry quinoa', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: quinoa.ulid, amount: 0.3 }],
      derived: { name: 'Cooked quinoa', shelf_life_class: 'fridge_short', on_hand_fraction: 1, recipe_ulid: RECIPE.ulid },
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
      derived: { name: 'Cooked quinoa', shelf_life_class: 'fridge_short', on_hand_fraction: 1 }, // no recipe_ulid
      at: '2026-07-17',
    });
    await expect(pipeline.consume(derived.ulid, { ulid: ULID(66) })).rejects.toThrow(ConsumeIneligibleError);
  });

  it('rejects a recipe_ulid that fails to resolve (unknown recipe)', async () => {
    const { pipeline } = harness([]); // resolveRecipe never finds anything
    const { item: oats } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived } = await pipeline.convert({
      sources: [{ item_ulid: oats.ulid }],
      derived: { name: 'Overnight oats jar', shelf_life_class: 'fridge_short', units_total: 3, recipe_ulid: RECIPE.ulid },
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
      derived: { name: 'Overnight oats jar', shelf_life_class: 'fridge_short', units_total: 1, recipe_ulid: RECIPE.ulid },
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
