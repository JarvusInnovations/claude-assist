import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { MemoryInventoryStore } from '../inventory-memory-store.js';
import { MemoryEntryStore } from '../memory-store.js';
import { MemoryConsumeStore } from '../services/consume-memory-store.js';
import { InventoryPipeline } from '../services/inventory.js';
import type { ReceiptParser } from '../services/receipt-parser.js';
import type { LabelParser, LabelParseInput } from '../services/label-parser.js';
import type { InventoryPhotoPart, ParsedLabel, ParsedReceipt } from '../inventory-types.js';
import type { RecipeRecord } from '../types.js';
import { generateUlid } from '../ulid.js';
import { registerInventoryRoutes } from './inventory.js';

class FakeReceiptParser implements ReceiptParser {
  constructor(private result: ParsedReceipt) {}
  async parse(): Promise<ParsedReceipt> {
    return this.result;
  }
}

/** Records the photos handed to it so a route test can pin the multi-photo shape. */
class CapturingLabelParser implements LabelParser {
  seen: InventoryPhotoPart[] = [];
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
  async parse(input: LabelParseInput): Promise<ParsedLabel> {
    this.seen = input.photos;
    return this.result;
  }
}

function buildMultipart(
  fields: Record<string, string>,
  files: Array<{ fieldname: string; filename: string; contentType: string; data: Buffer }> = []
): { body: Buffer; contentType: string } {
  const boundary = `----invTest${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    parts.push(
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
        ),
        file.data,
        Buffer.from('\r\n'),
      ])
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('inventory routes', () => {
  let fastify: FastifyInstance;
  let store: MemoryInventoryStore;
  let pipeline: InventoryPipeline;

  beforeEach(async () => {
    fastify = Fastify({ logger: false });
    store = new MemoryInventoryStore();
    pipeline = new InventoryPipeline(store, new FakeReceiptParser({ store: 'Example Grocer', lines: [{ text: 'MILK' }] }), null, fastify.log);
    await fastify.register(registerInventoryRoutes, { inventory: pipeline });
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('POST /kitchen/receipts accepts a multipart receipt + photo and returns the batch', async () => {
    const ulid = generateUlid();
    const { body, contentType } = buildMultipart(
      { receipt: JSON.stringify({ ulid, store: 'Example Grocer', purchased_at: '2026-07-18' }) },
      [{ fieldname: 'photo', filename: 'r.jpg', contentType: 'image/jpeg', data: Buffer.from('img') }]
    );
    const res = await fastify.inject({ method: 'POST', url: '/kitchen/receipts', payload: body, headers: { 'content-type': contentType } });
    expect(res.statusCode).toBe(201);
    const batch = res.json();
    expect(batch.ulid).toBe(ulid);
    expect(batch.status).toBe('parsing');
    await pipeline.settle();

    const view = await fastify.inject({ method: 'GET', url: `/kitchen/receipts/${ulid}` });
    expect(view.json().batch.status).toBe('parsed');
    expect(view.json().lines.length).toBe(1);
  });

  it('POST /kitchen/receipts rejects a bad ULID', async () => {
    const { body, contentType } = buildMultipart({ receipt: JSON.stringify({ ulid: 'nope' }) });
    const res = await fastify.inject({ method: 'POST', url: '/kitchen/receipts', payload: body, headers: { 'content-type': contentType } });
    expect(res.statusCode).toBe(400);
  });

  it('GET /kitchen/inventory returns on-hand items in eat-by order', async () => {
    await pipeline.createItem({ raw_label: 'Rice', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    await pipeline.createItem({ raw_label: 'Fish', shelf_life_class: 'very_perishable', acquired_at: '2026-07-16' });
    const res = await fastify.inject({ method: 'GET', url: '/kitchen/inventory' });
    expect(res.statusCode).toBe(200);
    const { items, count } = res.json();
    expect(count).toBe(2);
    expect(items[0].raw_label).toBe('Fish');
  });

  it('POST /kitchen/inventory/:ulid/events applies an explicit event; terminal → 409', async () => {
    const { item } = await pipeline.createItem({ raw_label: 'Yogurt', shelf_life_class: 'fridge_short', acquired_at: '2026-07-10' });
    const opened = await fastify.inject({ method: 'POST', url: `/kitchen/inventory/${item.ulid}/events`, payload: { type: 'opened', at: '2026-07-12' } });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().state).toBe('open');

    const finished = await fastify.inject({ method: 'POST', url: `/kitchen/inventory/${item.ulid}/events`, payload: { type: 'finished' } });
    expect(finished.json().state).toBe('finished');

    const again = await fastify.inject({ method: 'POST', url: `/kitchen/inventory/${item.ulid}/events`, payload: { type: 'opened' } });
    expect(again.statusCode).toBe(409);
  });

  it('POST /kitchen/inventory/:ulid/events partial toss decrements, then terminates at zero', async () => {
    const { item } = await pipeline.createItem({ raw_label: 'Tomatoes', shelf_life_class: 'produce', acquired_at: '2026-07-10' });

    // Partial toss: fraction is the AMOUNT tossed — item stays alive, decremented.
    const partial = await fastify.inject({
      method: 'POST',
      url: `/kitchen/inventory/${item.ulid}/events`,
      payload: { type: 'tossed', fraction: 0.4, at: '2026-07-12' },
    });
    expect(partial.statusCode).toBe(200);
    expect(partial.json().state).toBe('stocked');
    expect(partial.json().on_hand_fraction).toBeCloseTo(0.6, 5);
    expect(partial.json().closed_at).toBeNull();
    // Waste amount is recorded on the item's notes for telemetry.
    expect(partial.json().notes).toContain('tossed 0.4 2026-07-12');

    // Tossing the remainder reaches zero → terminal.
    const rest = await fastify.inject({
      method: 'POST',
      url: `/kitchen/inventory/${item.ulid}/events`,
      payload: { type: 'tossed', fraction: 0.6, at: '2026-07-13' },
    });
    expect(rest.statusCode).toBe(200);
    expect(rest.json().state).toBe('tossed');
    expect(rest.json().on_hand_fraction).toBe(0);
    expect(rest.json().closed_at).toBe('2026-07-13');
    expect(rest.json().notes).toContain('tossed 0.6 2026-07-13');

    // Terminal now: further events 409.
    const again = await fastify.inject({
      method: 'POST',
      url: `/kitchen/inventory/${item.ulid}/events`,
      payload: { type: 'tossed', fraction: 0.1 },
    });
    expect(again.statusCode).toBe(409);
  });

  it('POST /kitchen/inventory/:ulid/events tossed without a fraction is a full terminal toss', async () => {
    const { item } = await pipeline.createItem({ raw_label: 'Lettuce', shelf_life_class: 'produce', acquired_at: '2026-07-10' });
    const res = await fastify.inject({
      method: 'POST',
      url: `/kitchen/inventory/${item.ulid}/events`,
      payload: { type: 'tossed', at: '2026-07-14' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('tossed');
    expect(res.json().on_hand_fraction).toBe(0);
    expect(res.json().notes).toContain('tossed 1 2026-07-14');
  });

  it('POST /kitchen/inventory/events resolves a free-text remark', async () => {
    await pipeline.createItem({ raw_label: 'Feta', shelf_life_class: 'fridge_long', acquired_at: '2026-07-01' });
    const res = await fastify.inject({ method: 'POST', url: '/kitchen/inventory/events', payload: { remark: 'opened the feta' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().matched).toBe(true);
    expect(res.json().event.type).toBe('opened');

    const miss = await fastify.inject({ method: 'POST', url: '/kitchen/inventory/events', payload: { remark: 'opened the caviar' } });
    expect(miss.json().matched).toBe(false);
  });

  it('GET /kitchen/inventory/questions lists open needs-info items', async () => {
    await pipeline.createItem({ raw_label: 'MYSTERYITEM', acquired_at: '2026-07-10', needs_info: true });
    const res = await fastify.inject({ method: 'GET', url: '/kitchen/inventory/questions' });
    expect(res.json().count).toBe(1);
    expect(res.json().questions[0].raw_label).toBe('MYSTERYITEM');
  });

  it('GET /kitchen/inventory/questions groups a multi-quantity line into one question with a count', async () => {
    await pipeline.createItem({ raw_label: 'ITAL CHICKEN SAUSAGE', store: 'Example Grocer', acquired_at: '2026-07-18', needs_info: true });
    await pipeline.createItem({ raw_label: 'ITAL CHICKEN SAUSAGE', store: 'Example Grocer', acquired_at: '2026-07-19', needs_info: true });
    const res = await fastify.inject({ method: 'GET', url: '/kitchen/inventory/questions' });
    expect(res.statusCode).toBe(200);
    const { questions, count } = res.json();
    expect(count).toBe(1);
    expect(questions[0].count).toBe(2);
    expect(questions[0].item_ulids.length).toBe(2);
    expect(questions[0].question).toContain('×2');
  });

  it('POST /kitchen/inventory/:ulid/dismiss dismisses a line; 404 unknown; 409 terminal', async () => {
    const { item } = await pipeline.createItem({ raw_label: 'SOUP MUG', store: 'Example Grocer', acquired_at: '2026-07-18', needs_info: true });
    const res = await fastify.inject({ method: 'POST', url: `/kitchen/inventory/${item.ulid}/dismiss`, payload: { non_inventory: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().item.state).toBe('dismissed');
    expect(res.json().dismissed_count).toBe(1);
    expect(res.json().non_inventory).toBe(true);

    // Now terminal → 409.
    const again = await fastify.inject({ method: 'POST', url: `/kitchen/inventory/${item.ulid}/dismiss`, payload: {} });
    expect(again.statusCode).toBe(409);

    const missing = await fastify.inject({ method: 'POST', url: `/kitchen/inventory/${generateUlid()}/dismiss`, payload: {} });
    expect(missing.statusCode).toBe(404);
  });

  it('POST /kitchen/inventory/:ulid/label carries ALL photos[] parts to the parser as one product', async () => {
    // A dedicated app with a capturing label parser (the shared one has none).
    const app = Fastify({ logger: false });
    const s = new MemoryInventoryStore();
    const label = new CapturingLabelParser({
      name: 'Roma Tomatoes', shelf_life_class: 'produce', package_size: '1 lb',
      nutrition_per_100g: { calories: 18, protein_g: 0.9, fat_g: 0.2, sat_fat_g: 0, carbs_g: 3.9, sodium_mg: 5, fiber_g: 1.2, sugar_g: 2.6 },
      ingredients: 'Tomatoes', aliases: ['tomatoes'],
    });
    const pl = new InventoryPipeline(s, null, label, app.log);
    await app.register(registerInventoryRoutes, { inventory: pl });
    await app.ready();
    const { item } = await pl.createItem({ raw_label: 'TOMATOES', store: 'Example Grocer', acquired_at: '2026-07-18', needs_info: true });

    // Front label + nutrition panel + ingredients panel: three complementary shots, one scan.
    const { body, contentType } = buildMultipart(
      { label: JSON.stringify({ shelf_life_class: 'produce' }) },
      [
        { fieldname: 'photos', filename: 'front.jpg', contentType: 'image/jpeg', data: Buffer.from('front') },
        { fieldname: 'photos', filename: 'nutrition.jpg', contentType: 'image/jpeg', data: Buffer.from('nutrition') },
        { fieldname: 'photos', filename: 'ingredients.jpg', contentType: 'image/jpeg', data: Buffer.from('ingredients') },
      ]
    );
    const res = await app.inject({ method: 'POST', url: `/kitchen/inventory/${item.ulid}/label`, payload: body, headers: { 'content-type': contentType } });
    expect(res.statusCode).toBe(200);
    // All three photos reached the parser as one complementary set.
    expect(label.seen.length).toBe(3);
    const j = res.json();
    expect(j.item.needs_info).toBe(false);
    expect(j.product.ingredients).toBe('Tomatoes');
    expect(j.product.nutrition_per_100g.fiber_g).toBe(1.2);
    expect(j.resolved_count).toBe(1);
    await app.close();
  });

  it('POST /kitchen/inventory/:ulid/label 409s on a terminal item, 503 with no model', async () => {
    // 503: shared pipeline has a null label parser.
    const { item } = await pipeline.createItem({ raw_label: 'X', store: 'S', acquired_at: '2026-07-18', needs_info: true });
    const { body, contentType } = buildMultipart({}, [
      { fieldname: 'photos', filename: 'a.jpg', contentType: 'image/jpeg', data: Buffer.from('a') },
    ]);
    const noModel = await fastify.inject({ method: 'POST', url: `/kitchen/inventory/${item.ulid}/label`, payload: body, headers: { 'content-type': contentType } });
    expect(noModel.statusCode).toBe(503);

    // 409: a terminal item rejects the scan.
    const { item: term } = await pipeline.createItem({ raw_label: 'Y', acquired_at: '2026-07-18' });
    await pipeline.applyEvent(term.ulid, 'finished', { at: '2026-07-18' });
    const { body: b2, contentType: c2 } = buildMultipart({}, [
      { fieldname: 'photos', filename: 'a.jpg', contentType: 'image/jpeg', data: Buffer.from('a') },
    ]);
    const terminal = await fastify.inject({ method: 'POST', url: `/kitchen/inventory/${term.ulid}/label`, payload: b2, headers: { 'content-type': c2 } });
    expect(terminal.statusCode).toBe(409);
  });

  it("POST /kitchen/inventory/:ulid/events 'finished-unit' decrements a counted item; 400 on a fraction item", async () => {
    const counted = await fastify.inject({
      method: 'POST',
      url: '/kitchen/inventory',
      payload: { raw_label: 'Canned beans 3pk', shelf_life_class: 'pantry', acquired_at: '2026-07-01', units_total: 3 },
    });
    const item = counted.json();
    expect(item.units_remaining).toBe(3);

    const res = await fastify.inject({
      method: 'POST',
      url: `/kitchen/inventory/${item.ulid}/events`,
      payload: { type: 'finished-unit', at: '2026-07-10' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().units_remaining).toBe(2);
    expect(res.json().state).toBe('stocked');

    const { item: fractionItem } = await pipeline.createItem({ raw_label: 'Milk', shelf_life_class: 'fridge_short', acquired_at: '2026-07-01' });
    const bad = await fastify.inject({
      method: 'POST',
      url: `/kitchen/inventory/${fractionItem.ulid}/events`,
      payload: { type: 'finished-unit' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('POST /kitchen/inventory/convert decrements sources and creates a derived item; 400 on unknown source, 409 on terminal', async () => {
    const eggs = await pipeline.createItem({ raw_label: 'Egg dozen', shelf_life_class: 'fridge_long', acquired_at: '2026-07-01', units_total: 12 });

    const res = await fastify.inject({
      method: 'POST',
      url: '/kitchen/inventory/convert',
      payload: {
        sources: [{ item_ulid: eggs.item.ulid, amount: 6 }],
        derived: { name: 'Hard-boiled eggs', shelf_life_class: 'produce', units_total: 6 },
        at: '2026-07-10',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.sources[0].units_remaining).toBe(6);
    expect(body.derived.units_total).toBe(6);
    expect(body.derivation.sources[0].item_ulid).toBe(eggs.item.ulid);

    const unknown = await fastify.inject({
      method: 'POST',
      url: '/kitchen/inventory/convert',
      payload: { sources: [{ item_ulid: generateUlid() }], derived: { name: 'X' } },
    });
    expect(unknown.statusCode).toBe(400);

    const { item: terminal } = await pipeline.createItem({ raw_label: 'Old milk', shelf_life_class: 'fridge_short', acquired_at: '2026-07-01' });
    await pipeline.applyEvent(terminal.ulid, 'finished', {});
    const terminalRes = await fastify.inject({
      method: 'POST',
      url: '/kitchen/inventory/convert',
      payload: { sources: [{ item_ulid: terminal.ulid }], derived: { name: 'X' } },
    });
    expect(terminalRes.statusCode).toBe(409);
  });

  it('POST /kitchen/inventory/convert is source-less ("I made this") when sources omitted — creates a recipe-linked derived item, decrements nothing', async () => {
    const recipeUlid = generateUlid();
    const res = await fastify.inject({
      method: 'POST',
      url: '/kitchen/inventory/convert',
      payload: {
        derived: { name: 'Overnight-oats jar', shelf_life_class: 'prepared', recipe_ulid: recipeUlid },
        at: '2026-07-20',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.sources).toEqual([]); // nothing decremented
    expect(body.derived.raw_label).toBe('Overnight-oats jar');
    expect(body.derivation.sources).toEqual([]); // empty provenance
    expect(body.derivation.recipe_ulid).toBe(recipeUlid); // consume-eligibility hook

    // Empty sources array behaves identically to omitting the key.
    const emptyRes = await fastify.inject({
      method: 'POST',
      url: '/kitchen/inventory/convert',
      payload: { sources: [], derived: { name: 'Boiled eggs', units_total: 6 } },
    });
    expect(emptyRes.statusCode).toBe(201);
    expect(emptyRes.json().derived.units_total).toBe(6);

    // Still rejects a missing derived.name.
    const bad = await fastify.inject({
      method: 'POST',
      url: '/kitchen/inventory/convert',
      payload: { derived: {} },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('POST /kitchen/inventory/convert defaults a derived dish to the `prepared` class (~4-day eat-by), overridable', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/kitchen/inventory/convert',
      payload: { derived: { name: 'Overnight-oats jar' }, at: '2026-07-20' },
    });
    expect(res.statusCode).toBe(201);
    const item = res.json().derived;
    expect(item.shelf_life_class).toBe('prepared');
    expect(item.eat_by).toBe('2026-07-24'); // made 07-20 + 4 days — an honest eat-by, not null

    // An explicit class still wins (hard-boiled eggs keep ~a week).
    const eggs = await fastify.inject({
      method: 'POST',
      url: '/kitchen/inventory/convert',
      payload: {
        derived: { name: 'Hard-boiled eggs', shelf_life_class: 'produce', units_total: 6 },
        at: '2026-07-20',
      },
    });
    expect(eggs.json().derived.shelf_life_class).toBe('produce');
    expect(eggs.json().derived.eat_by).toBe('2026-07-27'); // produce unopened = 7 days
  });

  it('POST /kitchen/inventory/convert rejects a package-durable derived class with a 400 naming the made-food set — no item created', async () => {
    const before = await pipeline.listInventory({});

    for (const badClass of ['fridge_short', 'pantry', 'fridge_long']) {
      const res = await fastify.inject({
        method: 'POST',
        url: '/kitchen/inventory/convert',
        payload: { derived: { name: `Bad batch ${badClass}`, shelf_life_class: badClass }, at: '2026-07-10' },
      });
      expect(res.statusCode).toBe(400);
      // The structured error names the valid made-food set and points at prepared.
      expect(res.json().error).toContain('prepared, produce, very_perishable, frozen');
    }

    // No derived item was minted for any of the rejected attempts.
    const after = await pipeline.listInventory({});
    expect(after.length).toBe(before.length);
    expect(after.some((i) => i.raw_label?.startsWith('Bad batch'))).toBe(false);
  });

  it('POST /kitchen/inventory/:ulid/consume — one atomic call: exact-macro entry + deplete; 404/400/409/503 per case', async () => {
    // A dedicated app wired with the consume atomicity store + a recipe
    // resolver (the shared `pipeline` in the outer beforeEach has neither).
    const app = Fastify({ logger: false });
    const s = new MemoryInventoryStore();
    const e = new MemoryEntryStore();
    const recipe: RecipeRecord = {
      ulid: generateUlid(),
      name: 'Overnight oats',
      components: [{ label: 'oats', default_qty_g: 240, per_100g: { calories: 380, protein_g: 13, sat_fat_g: 1.2 } }],
      source: 'pushed',
      created_at: new Date(),
      updated_at: new Date(),
      archived_at: null,
    };
    const pl = new InventoryPipeline(s, null, null, app.log, {
      consumeStore: new MemoryConsumeStore(e, s),
      resolveRecipe: async (ulid) => (ulid === recipe.ulid ? recipe : null),
    });
    await app.register(registerInventoryRoutes, { inventory: pl });
    await app.ready();

    const { item: rawOats } = await pl.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const { derived } = await pl.convert({
      sources: [{ item_ulid: rawOats.ulid }],
      derived: { name: 'Overnight oats jar', shelf_life_class: 'prepared', units_total: 2, recipe_ulid: recipe.ulid },
      at: '2026-07-17',
    });

    const entryUlid = generateUlid();
    const res = await app.inject({
      method: 'POST',
      url: `/kitchen/inventory/${derived.ulid}/consume`,
      payload: { ulid: entryUlid },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.entry.ulid).toBe(entryUlid);
    expect(body.entry.source).toBe('reselect');
    expect(body.entry.status).toBe('estimated');
    expect(body.entry.calories).toBe(912); // per-unit recipe contract: 1 unit = the whole recipe (240*3.8)
    expect(body.item.units_remaining).toBe(1);
    expect(body.item.state).toBe('stocked');

    // Idempotent replay: same 201/200 contract as receipts/batches — a
    // replay of an already-created row returns 200, not 201.
    const replay = await app.inject({
      method: 'POST',
      url: `/kitchen/inventory/${derived.ulid}/consume`,
      payload: { ulid: entryUlid },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().created).toBe(false);
    expect(replay.json().item.units_remaining).toBe(1); // not depleted again

    // 404: unknown item.
    const missing = await app.inject({
      method: 'POST',
      url: `/kitchen/inventory/${generateUlid()}/consume`,
      payload: { ulid: generateUlid() },
    });
    expect(missing.statusCode).toBe(404);

    // 400: ineligible item (no recipe-linked derivation).
    const { item: plain } = await pl.createItem({ raw_label: 'Plain yogurt', shelf_life_class: 'fridge_short', acquired_at: '2026-07-01' });
    const ineligible = await app.inject({
      method: 'POST',
      url: `/kitchen/inventory/${plain.ulid}/consume`,
      payload: { ulid: generateUlid() },
    });
    expect(ineligible.statusCode).toBe(400);

    // 409: terminal item.
    await pl.applyEvent(plain.ulid, 'finished', {});
    const terminal = await app.inject({
      method: 'POST',
      url: `/kitchen/inventory/${plain.ulid}/consume`,
      payload: { ulid: generateUlid() },
    });
    expect(terminal.statusCode).toBe(409);

    await app.close();

    // 503: the shared `pipeline` (outer beforeEach) has no consumeStore/resolveRecipe wired.
    const { item: unwired } = await pipeline.createItem({ raw_label: 'Rolled oats', shelf_life_class: 'pantry', acquired_at: '2026-07-01' });
    const notConfigured = await fastify.inject({
      method: 'POST',
      url: `/kitchen/inventory/${unwired.ulid}/consume`,
      payload: { ulid: generateUlid() },
    });
    expect(notConfigured.statusCode).toBe(503);
  });

  it('POST /kitchen/products then /kitchen/lexicon are creatable for the seed port', async () => {
    const p = await fastify.inject({ method: 'POST', url: '/kitchen/products', payload: { name: 'Oat Milk', shelf_life_class: 'fridge_short', aliases: ['oatmilk'] } });
    expect(p.statusCode).toBe(201);
    const productUlid = p.json().ulid;
    const l = await fastify.inject({ method: 'POST', url: '/kitchen/lexicon', payload: { store: 'Example Grocer', line_text: 'OAT MILK', product_ulid: productUlid } });
    expect(l.statusCode).toBe(201);
    expect(l.json().line_text).toBe('OAT MILK');
  });

  it('PATCH /kitchen/inventory/:ulid reconciles quantities/model/state; 400 invalid; 404 unknown', async () => {
    const { item } = await pipeline.createItem({ raw_label: 'Soymilk', shelf_life_class: 'fridge_short', acquired_at: '2026-07-17' });
    await pipeline.applyEvent(item.ulid, 'opened', { at: '2026-07-19', fraction: 0.34 });

    const fixed = await fastify.inject({ method: 'PATCH', url: `/kitchen/inventory/${item.ulid}`, payload: { on_hand_fraction: 0.75 } });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().on_hand_fraction).toBe(0.75);
    expect(fixed.json().opened_at).toBe('2026-07-19'); // clock untouched
    expect(fixed.json().notes).toContain('reconciled');

    // Reclassify to counted while correcting state to sealed.
    const counted = await fastify.inject({ method: 'PATCH', url: `/kitchen/inventory/${item.ulid}`, payload: { units_total: 3, units_remaining: 2, state: 'stocked' } });
    expect(counted.statusCode).toBe(200);
    expect(counted.json().units_remaining).toBe(2);
    expect(counted.json().state).toBe('stocked');
    expect(counted.json().opened_at).toBeNull();

    const bad = await fastify.inject({ method: 'PATCH', url: `/kitchen/inventory/${item.ulid}`, payload: { on_hand_fraction: 0.5 } });
    expect(bad.statusCode).toBe(400); // fraction on a counted item

    const empty = await fastify.inject({ method: 'PATCH', url: `/kitchen/inventory/${item.ulid}`, payload: {} });
    expect(empty.statusCode).toBe(400); // minProperties: 1

    const missing = await fastify.inject({ method: 'PATCH', url: `/kitchen/inventory/${generateUlid()}`, payload: { on_hand_fraction: 0.5 } });
    expect(missing.statusCode).toBe(404);
  });
});

/**
 * Product corrections (specs/modules/kitchen.md § Product corrections).
 *
 * The defect these close: `POST /kitchen/products` was create-only, no
 * PATCH/DELETE route existed, and the body schema had no `ulid` property under
 * `additionalProperties: false` — so a caller supplying an existing product's
 * ULID had it stripped, got a fresh record, and was answered 201.
 */
describe('product corrections routes', () => {
  let fastify: FastifyInstance;
  let store: MemoryInventoryStore;
  let pipeline: InventoryPipeline;

  const FULL_PANEL = {
    calories: 120, protein_g: 4, fat_g: 2, sat_fat_g: 0.5,
    carbs_g: 20, sugar_g: 6, added_sugar_g: 0, fiber_g: 3, sodium_mg: 90,
  };

  beforeEach(async () => {
    fastify = Fastify({ logger: false });
    store = new MemoryInventoryStore();
    pipeline = new InventoryPipeline(store, new FakeReceiptParser({ store: 'Example Grocer', lines: [] }), null, fastify.log);
    await fastify.register(registerInventoryRoutes, { inventory: pipeline });
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  const post = (payload: Record<string, unknown>) =>
    fastify.inject({ method: 'POST', url: '/kitchen/products', payload });
  const patch = (ulid: string, payload: Record<string, unknown>) =>
    fastify.inject({ method: 'PATCH', url: `/kitchen/products/${ulid}`, payload });

  it('POST honors an explicit ulid — 201 create, 200 replace, never a silent duplicate', async () => {
    const ulid = generateUlid();
    const created = await post({ ulid, name: 'Rolled Oats', shelf_life_class: 'pantry' });
    expect(created.statusCode).toBe(201);
    expect(created.json().ulid).toBe(ulid);

    // THE REGRESSION: re-posting that ULID must not mint a second record. It
    // used to be stripped and answered 201.
    const replaced = await post({ ulid, name: 'Rolled Oats', nutrition_per_100g: FULL_PANEL });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().ulid).toBe(ulid);
    expect(replaced.json().nutrition_per_100g.calories).toBe(120);

    const list = await fastify.inject({ method: 'GET', url: '/kitchen/products' });
    expect(list.json().count).toBe(1);
  });

  it('an explicit-ulid replace states the whole record — omitted fields revert (the only way to clear one)', async () => {
    const ulid = generateUlid();
    await post({ ulid, name: 'Olive Oil', shelf_life_class: 'pantry', package_size: '16 oz', nutrition_per_100g: FULL_PANEL });
    const replaced = await post({ ulid, name: 'Olive Oil' });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().package_size).toBeNull();
    expect(replaced.json().nutrition_per_100g).toBeNull();
    expect(replaced.json().shelf_life_class).toBe('unknown');
  });

  it('POST without a ulid keys on the normalized name and ENRICHES — a bare re-seed never erases a panel', async () => {
    const created = await post({ name: 'Greek Yogurt', shelf_life_class: 'fridge_short', nutrition_per_100g: FULL_PANEL });
    expect(created.statusCode).toBe(201);
    const ulid = created.json().ulid;

    // The receipt-seed shape: name only, differing in case and spacing.
    const reseeded = await post({ name: '  greek   yogurt ' });
    expect(reseeded.statusCode).toBe(200);
    expect(reseeded.json().ulid).toBe(ulid);
    expect(reseeded.json().nutrition_per_100g.calories).toBe(120); // NOT clobbered
    expect(reseeded.json().shelf_life_class).toBe('fridge_short'); // `unknown` never overrides

    // A partial panel fills a gap without erasing the banked fields.
    const partial = await post({ name: 'Greek Yogurt', nutrition_per_100g: { sodium_mg: 55 } });
    expect(partial.json().nutrition_per_100g.sodium_mg).toBe(55);
    expect(partial.json().nutrition_per_100g.protein_g).toBe(4);
  });

  it('POST refuses an ambiguous name key with 409 naming both candidates', async () => {
    const a = generateUlid();
    const b = generateUlid();
    await post({ ulid: a, name: 'Paprika' });
    await post({ ulid: b, name: 'paprika' }); // explicit ulid is the escape hatch, so this is allowed

    const ambiguous = await post({ name: 'Paprika' });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json().error).toContain(a);
    expect(ambiguous.json().error).toContain(b);
  });

  it('PATCH is partial — unspecified fields survive, and the panel merges per-field', async () => {
    const created = await post({
      name: 'Canned Tomatoes',
      shelf_life_class: 'pantry',
      package_size: '28 oz',
      aliases: ['tomatoes'],
      nutrition_per_100g: { ...FULL_PANEL, sodium_mg: null },
    });
    const ulid = created.json().ulid;

    const filled = await patch(ulid, { nutrition_per_100g: { sodium_mg: 180 } });
    expect(filled.statusCode).toBe(200);
    expect(filled.json().nutrition_per_100g.sodium_mg).toBe(180);
    expect(filled.json().nutrition_per_100g.calories).toBe(120); // other eight untouched
    expect(filled.json().package_size).toBe('28 oz'); // top-level untouched
    expect(filled.json().aliases).toEqual(['tomatoes']);
    expect(filled.json().shelf_life_class).toBe('pantry');

    // An explicit null clears exactly one field — a patch is the owner stating
    // what is true, unlike an enrich, which must never null-clobber a guess.
    const cleared = await patch(ulid, { nutrition_per_100g: { calories: null } });
    expect(cleared.json().nutrition_per_100g.calories).toBeNull();
    expect(cleared.json().nutrition_per_100g.sodium_mg).toBe(180);

    // …and a null panel clears the whole thing.
    const wiped = await patch(ulid, { nutrition_per_100g: null });
    expect(wiped.json().nutrition_per_100g).toBeNull();

    expect((await patch(ulid, {})).statusCode).toBe(400); // minProperties: 1
    expect((await patch(generateUlid(), { package_size: '1 lb' })).statusCode).toBe(404);
  });

  it('PATCH renames (identity is the ulid) but refuses a rename into a live twin', async () => {
    const mangled = (await post({ name: 'KRKLND SGNTR OO' })).json();
    const other = (await post({ name: 'Olive Oil' })).json();

    const renamed = await patch(mangled.ulid, { name: 'Extra Virgin Olive Oil' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe('Extra Virgin Olive Oil');
    expect(renamed.json().ulid).toBe(mangled.ulid);

    const collision = await patch(mangled.ulid, { name: 'olive oil' });
    expect(collision.statusCode).toBe(409);
    expect(collision.json().error).toContain(other.ulid);

    // Restating the name it already has is never a collision with itself.
    expect((await patch(other.ulid, { name: 'Olive Oil', package_size: '750 ml' })).statusCode).toBe(200);
  });

  it('merge relinks every dependent to the survivor and archives the loser', async () => {
    const survivor = (await post({ name: 'Whole Milk', shelf_life_class: 'fridge_short', nutrition_per_100g: FULL_PANEL })).json();
    const dupe = (await post({ name: 'Milk, Whole', package_size: '1 gal', aliases: ['milk'] })).json();

    // Everything that points at a product: an item, a lexicon line, a batch line.
    const { item } = await pipeline.createItem({ product_ulid: dupe.ulid, raw_label: 'WHOLE MILK', acquired_at: '2026-07-20' });
    await pipeline.upsertLexicon({ store: 'Example Grocer', line_text: 'WHOLE MILK', product_ulid: dupe.ulid });
    const batch = await store.insertBatchIfAbsent({ ulid: generateUlid(), source: 'receipt', store: 'Example Grocer', purchased_at: new Date('2026-07-20') });
    await store.insertLine({
      ulid: generateUlid(), batch_ulid: batch.record.ulid, raw_text: 'WHOLE MILK',
      match_outcome: 'matched', product_ulid: dupe.ulid, inventory_item_ulid: item.ulid,
    });

    const merged = await fastify.inject({ method: 'POST', url: `/kitchen/products/${dupe.ulid}/merge`, payload: { into: survivor.ulid } });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().relinked).toEqual({ items: 1, lexicon_lines: 1, batch_lines: 1 });
    expect(merged.json().merged.merged_into).toBe(survivor.ulid);
    expect(merged.json().merged.archived_at).not.toBeNull();

    // The survivor gained what only the duplicate carried, kept its own panel,
    // and answers to the loser's old name.
    expect(merged.json().product.package_size).toBe('1 gal');
    expect(merged.json().product.nutrition_per_100g.calories).toBe(120);
    expect(merged.json().product.aliases).toContain('Milk, Whole');

    // Dependents now resolve to the survivor…
    const view = await fastify.inject({ method: 'GET', url: `/kitchen/inventory/${item.ulid}` });
    expect(view.json().product_ulid).toBe(survivor.ulid);
    expect(view.json().product_name).toBe('Whole Milk');
    // …and the loser is off the listing but still resolvable by ULID.
    const list = await fastify.inject({ method: 'GET', url: '/kitchen/products' });
    expect(list.json().products.map((p: { ulid: string }) => p.ulid)).toEqual([survivor.ulid]);
    expect(await store.getProduct(dupe.ulid)).not.toBeNull();

    // Idempotent: the same merge again relinks nothing and still succeeds.
    const replay = await fastify.inject({ method: 'POST', url: `/kitchen/products/${dupe.ulid}/merge`, payload: { into: survivor.ulid } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().relinked).toEqual({ items: 0, lexicon_lines: 0, batch_lines: 0 });
  });

  it('merge refuses a self-merge (400), an unknown side (404), and a retargeted loser (409)', async () => {
    const a = (await post({ name: 'Cumin' })).json();
    const b = (await post({ name: 'Ground Cumin' })).json();
    const c = (await post({ name: 'Cumin Seed' })).json();

    const self = await fastify.inject({ method: 'POST', url: `/kitchen/products/${a.ulid}/merge`, payload: { into: a.ulid } });
    expect(self.statusCode).toBe(400);

    const unknown = await fastify.inject({ method: 'POST', url: `/kitchen/products/${a.ulid}/merge`, payload: { into: generateUlid() } });
    expect(unknown.statusCode).toBe(404);

    await fastify.inject({ method: 'POST', url: `/kitchen/products/${b.ulid}/merge`, payload: { into: a.ulid } });
    const retargeted = await fastify.inject({ method: 'POST', url: `/kitchen/products/${b.ulid}/merge`, payload: { into: c.ulid } });
    expect(retargeted.statusCode).toBe(409);
    expect(retargeted.json().error).toContain(a.ulid);

    // And merging INTO a retired record is refused rather than burying it twice.
    const intoRetired = await fastify.inject({ method: 'POST', url: `/kitchen/products/${c.ulid}/merge`, payload: { into: b.ulid } });
    expect(intoRetired.statusCode).toBe(409);
  });

  it('DELETE archives (never destroys), is idempotent, and blocks a replace of the retired record', async () => {
    const p = (await post({ name: 'Misread Receipt Line' })).json();
    const { item } = await pipeline.createItem({ product_ulid: p.ulid, acquired_at: '2026-07-20' });

    const archived = await fastify.inject({ method: 'DELETE', url: `/kitchen/products/${p.ulid}` });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().archived_at).not.toBeNull();
    expect(archived.json().merged_into).toBeNull();

    expect((await fastify.inject({ method: 'DELETE', url: `/kitchen/products/${p.ulid}` })).statusCode).toBe(200);
    expect((await fastify.inject({ method: 'DELETE', url: `/kitchen/products/${generateUlid()}` })).statusCode).toBe(404);

    // Off the listing, still resolvable by ULID — history never breaks.
    expect((await fastify.inject({ method: 'GET', url: '/kitchen/products' })).json().count).toBe(0);
    const view = await fastify.inject({ method: 'GET', url: `/kitchen/inventory/${item.ulid}` });
    expect(view.json().product_name).toBe('Misread Receipt Line');

    // A retired record is refused, not resurrected…
    expect((await post({ ulid: p.ulid, name: 'Misread Receipt Line' })).statusCode).toBe(409);
    // …and its name is free again for a fresh record.
    const fresh = await post({ name: 'Misread Receipt Line' });
    expect(fresh.statusCode).toBe(201);
    expect(fresh.json().ulid).not.toBe(p.ulid);
  });

  it('a nutrition_negligible product clears needs_nutrition with no panel at all', async () => {
    // A spice jar: no Nutrition Facts panel exists to scan, so the flag is
    // otherwise unclearable (§ Nutritionally negligible products).
    const spice = (await post({ name: 'Smoked Paprika', shelf_life_class: 'pantry' })).json();
    const { item } = await pipeline.createItem({ product_ulid: spice.ulid, acquired_at: '2026-07-20' });

    const flagged = await fastify.inject({ method: 'GET', url: `/kitchen/inventory/${item.ulid}` });
    expect(flagged.json().needs_nutrition).toBe(true);

    const marked = await patch(spice.ulid, { nutrition_negligible: true });
    expect(marked.statusCode).toBe(200);
    expect(marked.json().nutrition_negligible).toBe(true);
    expect(marked.json().nutrition_per_100g).toBeNull(); // zeros are derived, never written

    const cleared = await fastify.inject({ method: 'GET', url: `/kitchen/inventory/${item.ulid}` });
    expect(cleared.json().needs_nutrition).toBe(false);

    // Reversible — the marker is one boolean, and unmarking restores the flag.
    await patch(spice.ulid, { nutrition_negligible: false });
    const reflagged = await fastify.inject({ method: 'GET', url: `/kitchen/inventory/${item.ulid}` });
    expect(reflagged.json().needs_nutrition).toBe(true);
  });

  it('the marker survives an enrich — only an explicit PATCH clears it', async () => {
    const spice = (await post({ name: 'Ground Cinnamon', nutrition_negligible: true })).json();
    expect(spice.nutrition_negligible).toBe(true);

    const reseeded = await post({ name: 'Ground Cinnamon', package_size: '2.5 oz' });
    expect(reseeded.json().nutrition_negligible).toBe(true);
    expect((await patch(spice.ulid, { nutrition_negligible: false })).json().nutrition_negligible).toBe(false);
  });
});
