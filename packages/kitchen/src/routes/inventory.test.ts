import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { MemoryInventoryStore } from '../inventory-memory-store.js';
import { InventoryPipeline } from '../services/inventory.js';
import type { ReceiptParser } from '../services/receipt-parser.js';
import type { ParsedReceipt } from '../inventory-types.js';
import { generateUlid } from '../ulid.js';
import { registerInventoryRoutes } from './inventory.js';

class FakeReceiptParser implements ReceiptParser {
  constructor(private result: ParsedReceipt) {}
  async parse(): Promise<ParsedReceipt> {
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

  it('POST /kitchen/products then /kitchen/lexicon are creatable for the seed port', async () => {
    const p = await fastify.inject({ method: 'POST', url: '/kitchen/products', payload: { name: 'Oat Milk', shelf_life_class: 'fridge_short', aliases: ['oatmilk'] } });
    expect(p.statusCode).toBe(201);
    const productUlid = p.json().ulid;
    const l = await fastify.inject({ method: 'POST', url: '/kitchen/lexicon', payload: { store: 'Example Grocer', line_text: 'OAT MILK', product_ulid: productUlid } });
    expect(l.statusCode).toBe(201);
    expect(l.json().line_text).toBe('OAT MILK');
  });
});
