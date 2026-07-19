import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { MemoryInventoryStore } from '../inventory-memory-store.js';
import { InventoryPipeline } from './inventory.js';
import type { ReceiptParser, ReceiptParseInput } from './receipt-parser.js';
import type { LabelParser, LabelParseInput } from './label-parser.js';
import type { InventoryPhotoPart, ParsedLabel, ParsedReceipt } from '../inventory-types.js';

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
});

describe('label intake', () => {
  it('resolves a needs_info item, enriches the product, and writes the lexicon so the next receipt auto-resolves', async () => {
    const store = new MemoryInventoryStore();
    const parser = new FakeReceiptParser({ store: 'Example Grocer', lines: [{ text: 'TOMATOESOR' }] });
    const label = new FakeLabelParser({
      name: 'Roma Tomatoes',
      shelf_life_class: 'produce',
      package_size: '1 lb',
      nutrition_per_100g: { calories: 18, protein_g: 0.9, fat_g: 0.2, sat_fat_g: 0, carbs_g: 3.9, sodium_mg: 5 },
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
      nutrition_per_100g: null, package_size: null, shelf_life_days_unopened: null, shelf_life_days_opened: null,
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
      nutrition_per_100g: null, package_size: null, shelf_life_days_unopened: null, shelf_life_days_opened: null,
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
