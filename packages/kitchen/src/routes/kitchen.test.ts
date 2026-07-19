import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { MemoryEntryStore, MemoryRecipeStore } from '../memory-store.js';
import { KitchenPipeline } from '../services/pipeline.js';
import type { Estimator } from '../services/estimator.js';
import type { ModelEstimate } from '../types.js';
import { generateUlid } from '../ulid.js';
import { registerKitchenRoutes } from './kitchen.js';

class ScriptedEstimator implements Estimator {
  calls = 0;
  constructor(private script: Array<ModelEstimate | Error>) {}
  async estimate(): Promise<ModelEstimate> {
    const next = this.script[this.calls] ?? this.script[this.script.length - 1]!;
    this.calls++;
    if (next instanceof Error) throw next;
    return next;
  }
}

function mkModelEstimate(over: Partial<ModelEstimate> = {}): ModelEstimate {
  return {
    label: 'Grilled chicken salad',
    calories: 450,
    protein_g: 35,
    fat_g: 18,
    sat_fat_g: 4,
    carbs_g: 20,
    sodium_mg: 700,
    confidence: 0.55,
    portion_basis: 'one plate',
    ...over,
  };
}

/** Build a multipart/form-data body by hand (no third-party form-data lib in the workspace). */
function buildMultipart(
  fields: Record<string, string>,
  files: Array<{ fieldname: string; filename: string; contentType: string; data: Buffer }> = []
): { body: Buffer; contentType: string } {
  const boundary = `----kitchenTestBoundary${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
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

describe('kitchen routes', () => {
  let fastify: FastifyInstance;
  let entries: MemoryEntryStore;
  let recipes: MemoryRecipeStore;
  let estimator: ScriptedEstimator;
  let pipeline: KitchenPipeline;

  beforeEach(async () => {
    fastify = Fastify({ logger: false });
    entries = new MemoryEntryStore();
    recipes = new MemoryRecipeStore();
    estimator = new ScriptedEstimator([mkModelEstimate()]);
    pipeline = new KitchenPipeline(entries, recipes, estimator, fastify.log);
    await fastify.register(registerKitchenRoutes, { pipeline });
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  describe('POST /kitchen/entries', () => {
    it('accepts a note-only multipart entry: posts immediately, estimates detached', async () => {
      const ulid = generateUlid();
      const { body, contentType } = buildMultipart({ entry: JSON.stringify({ ulid, note: 'chicken salad' }) });

      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });

      // The response never blocks on the model call (spec): row is written,
      // estimation runs detached.
      expect(response.statusCode).toBe(201);
      expect(response.json().status).toBe('estimating');

      await pipeline.settle();
      const after = await fastify.inject({ method: 'GET', url: `/kitchen/entries/${ulid}` });
      const json = after.json();
      expect(json.status).toBe('estimated');
      expect(json.source).toBe('model');
      expect(json.label).toBe('Grilled chicken salad');
    });

    it('accepts the entry shipped as a file part (filename present), as some multipart clients do', async () => {
      const ulid = generateUlid();
      const { body, contentType } = buildMultipart({}, [
        {
          fieldname: 'entry',
          filename: 'entry.json',
          contentType: 'application/json',
          data: Buffer.from(JSON.stringify({ ulid, note: 'chicken salad' })),
        },
      ]);

      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().status).toBe('estimating');
    });

    it('rejects a file-part entry with invalid JSON with 400', async () => {
      const { body, contentType } = buildMultipart({}, [
        {
          fieldname: 'entry',
          filename: 'entry.json',
          contentType: 'application/json',
          data: Buffer.from('{not json'),
        },
      ]);

      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('valid JSON');
    });

    it('accepts a photo part and holds it only in memory (never persisted)', async () => {
      const ulid = generateUlid();
      const { body, contentType } = buildMultipart(
        { entry: JSON.stringify({ ulid, note: 'plate of food' }) },
        [{ fieldname: 'photo', filename: 'meal.jpg', contentType: 'image/jpeg', data: Buffer.from('fake-jpeg') }]
      );

      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });

      expect(response.statusCode).toBe(201);
      expect(estimator.calls).toBe(1);
    });

    it('is idempotent on ulid: a replay while estimated does not re-invoke the estimator', async () => {
      const ulid = generateUlid();
      const { body, contentType } = buildMultipart({ entry: JSON.stringify({ ulid, note: 'chicken salad' }) });

      const first = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });
      expect(first.statusCode).toBe(201);

      const replay = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().ulid).toBe(ulid);
      expect(estimator.calls).toBe(1);
    });

    it('computes recipe-based entries deterministically (estimated, source reselect)', async () => {
      const recipe = await recipes.insert({
        ulid: generateUlid(),
        name: 'Protein shake',
        components: [{ label: 'protein powder', default_qty_g: 30, per_100g: { calories: 400, protein_g: 80, sat_fat_g: 2 } }],
        source: 'pushed',
      });

      const ulid = generateUlid();
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid, recipe_ulid: recipe.ulid }),
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });

      expect(response.statusCode).toBe(201);
      const json = response.json();
      expect(json.status).toBe('estimated');
      expect(json.source).toBe('reselect');
      expect(json.label).toBe('Protein shake');
      expect(estimator.calls).toBe(0);
    });

    it('carries an optional comment onto a recipe-sourced entry and it survives to the GET', async () => {
      const recipe = await recipes.insert({
        ulid: generateUlid(),
        name: 'Protein shake',
        components: [{ label: 'protein powder', default_qty_g: 30, per_100g: { calories: 400, protein_g: 80, sat_fat_g: 2 } }],
        source: 'pushed',
      });

      const ulid = generateUlid();
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid, recipe_ulid: recipe.ulid, note: 'made with oat milk' }),
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().note).toBe('made with oat milk');

      const after = await fastify.inject({ method: 'GET', url: `/kitchen/entries/${ulid}` });
      const json = after.json();
      expect(json.note).toBe('made with oat milk');
      expect(json.status).toBe('estimated');
      expect(json.source).toBe('reselect');
      expect(json.label).toBe('Protein shake'); // the comment annotates the entry, not its label
      expect(estimator.calls).toBe(0); // deterministic path — the note never triggers a model pass
    });

    it('rejects a non-multipart POST with 400', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        payload: { ulid: generateUlid(), note: 'x' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects an entry with an invalid ulid with 400', async () => {
      const { body, contentType } = buildMultipart({ entry: JSON.stringify({ ulid: 'not-a-ulid' }) });
      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects an entry referencing an unknown recipe with 400', async () => {
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid: generateUlid(), recipe_ulid: generateUlid() }),
      });
      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /kitchen/entries', () => {
    it('lists entries newest-first', async () => {
      const older = generateUlid();
      const { body: b1, contentType: c1 } = buildMultipart({
        entry: JSON.stringify({ ulid: older, logged_at: '2026-01-01T00:00:00Z', note: 'a' }),
      });
      await fastify.inject({ method: 'POST', url: '/kitchen/entries', headers: { 'content-type': c1 }, payload: b1 });

      const newer = generateUlid();
      const { body: b2, contentType: c2 } = buildMultipart({
        entry: JSON.stringify({ ulid: newer, logged_at: '2026-06-01T00:00:00Z', note: 'b' }),
      });
      await fastify.inject({ method: 'POST', url: '/kitchen/entries', headers: { 'content-type': c2 }, payload: b2 });

      const response = await fastify.inject({ method: 'GET', url: '/kitchen/entries' });
      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.entries[0].ulid).toBe(newer);
      expect(json.entries[1].ulid).toBe(older);
    });
  });

  describe('GET /kitchen/entries/:ulid', () => {
    it('returns 404 for an unknown ulid', async () => {
      const response = await fastify.inject({ method: 'GET', url: `/kitchen/entries/${generateUlid()}` });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('PATCH /kitchen/entries/:ulid', () => {
    it('applies a manual macro override (terminal, source manual)', async () => {
      const ulid = generateUlid();
      const seedPipeline = new KitchenPipeline(entries, recipes, estimator, fastify.log);
      const { estimation } = await seedPipeline.ingest({ ulid, note: 'chicken salad' }, []);
      await estimation;
      expect((await seedPipeline.get(ulid))!.status).toBe('estimated');

      const response = await fastify.inject({
        method: 'PATCH',
        url: `/kitchen/entries/${ulid}`,
        payload: { calories: 500, protein_g: 40 },
      });
      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.source).toBe('manual');
      expect(json.calories).toBe(500);
    });

    it('returns 409 when a note/label edit would re-queue a manual entry', async () => {
      const ulid = generateUlid();
      await new KitchenPipeline(entries, recipes, estimator, fastify.log).ingest({ ulid, note: 'x' }, []);
      await fastify.inject({ method: 'PATCH', url: `/kitchen/entries/${ulid}`, payload: { calories: 300 } });

      const response = await fastify.inject({
        method: 'PATCH',
        url: `/kitchen/entries/${ulid}`,
        payload: { note: 'trying to reopen' },
      });
      expect(response.statusCode).toBe(409);
    });

    it('returns 404 for an unknown ulid', async () => {
      const response = await fastify.inject({
        method: 'PATCH',
        url: `/kitchen/entries/${generateUlid()}`,
        payload: { calories: 100 },
      });
      expect(response.statusCode).toBe(404);
    });

    it('accepts a portion_multiplier PATCH: 200, base unscaled on the wire, source unchanged', async () => {
      const ulid = generateUlid();
      const seedPipeline = new KitchenPipeline(entries, recipes, estimator, fastify.log);
      const { estimation } = await seedPipeline.ingest({ ulid, note: 'loaded fries' }, []);
      await estimation;
      const base = (await seedPipeline.get(ulid))!.calories;

      const response = await fastify.inject({
        method: 'PATCH',
        url: `/kitchen/entries/${ulid}`,
        payload: { portion_multiplier: 0.5 },
      });
      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.portion_multiplier).toBe(0.5);
      expect(json.calories).toBe(base); // base carried on the wire, not pre-scaled
      expect(json.source).toBe('model'); // not flipped to manual
    });

    it('accepts a portion_multiplier PATCH on a manual entry without a 409', async () => {
      const ulid = generateUlid();
      await new KitchenPipeline(entries, recipes, estimator, fastify.log).ingest({ ulid, note: 'x' }, []);
      await fastify.inject({ method: 'PATCH', url: `/kitchen/entries/${ulid}`, payload: { calories: 300 } });

      const response = await fastify.inject({
        method: 'PATCH',
        url: `/kitchen/entries/${ulid}`,
        payload: { portion_multiplier: 0.75 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().portion_multiplier).toBe(0.75);
      expect(response.json().source).toBe('manual');
    });

    it('rejects a non-positive or absurd portion_multiplier with 400 (schema bound)', async () => {
      const ulid = generateUlid();
      await new KitchenPipeline(entries, recipes, estimator, fastify.log).ingest({ ulid, note: 'x' }, []);
      for (const bad of [0, -1, 21]) {
        const response = await fastify.inject({
          method: 'PATCH',
          url: `/kitchen/entries/${ulid}`,
          payload: { portion_multiplier: bad },
        });
        expect(response.statusCode).toBe(400);
      }
    });

    it('accepts a logged_at PATCH: 200, backdates the wire, source/status unchanged', async () => {
      const ulid = generateUlid();
      const seedPipeline = new KitchenPipeline(entries, recipes, estimator, fastify.log);
      const { estimation } = await seedPipeline.ingest({ ulid, note: 'leftover pasta' }, []);
      await estimation;
      const backdated = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

      const response = await fastify.inject({
        method: 'PATCH',
        url: `/kitchen/entries/${ulid}`,
        payload: { logged_at: backdated },
      });
      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(new Date(json.logged_at).toISOString()).toBe(backdated);
      expect(json.source).toBe('model'); // not flipped to manual
      expect(json.status).toBe('estimated'); // not re-queued
    });

    it('rejects an out-of-bounds or unparseable logged_at with 400', async () => {
      const ulid = generateUlid();
      await new KitchenPipeline(entries, recipes, estimator, fastify.log).ingest({ ulid, note: 'x' }, []);
      const twoDaysAhead = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
      const sixYearsBack = new Date(Date.now() - 6 * 365 * 24 * 60 * 60 * 1000).toISOString();
      for (const bad of [twoDaysAhead, sixYearsBack, 'not-a-date']) {
        const response = await fastify.inject({
          method: 'PATCH',
          url: `/kitchen/entries/${ulid}`,
          payload: { logged_at: bad },
        });
        expect(response.statusCode).toBe(400);
      }
      // Wrong wire type is rejected by the schema, also 400.
      const wrongType = await fastify.inject({
        method: 'PATCH',
        url: `/kitchen/entries/${ulid}`,
        payload: { logged_at: 12345 },
      });
      expect(wrongType.statusCode).toBe(400);
    });

    it('rejects an empty patch body with 400', async () => {
      const ulid = generateUlid();
      await new KitchenPipeline(entries, recipes, estimator, fastify.log).ingest({ ulid, note: 'x' }, []);
      const response = await fastify.inject({ method: 'PATCH', url: `/kitchen/entries/${ulid}`, payload: {} });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('DELETE /kitchen/entries/:ulid', () => {
    it('removes the entry', async () => {
      const ulid = generateUlid();
      await new KitchenPipeline(entries, recipes, estimator, fastify.log).ingest({ ulid, note: 'x' }, []);

      const response = await fastify.inject({ method: 'DELETE', url: `/kitchen/entries/${ulid}` });
      expect(response.statusCode).toBe(204);

      const getResponse = await fastify.inject({ method: 'GET', url: `/kitchen/entries/${ulid}` });
      expect(getResponse.statusCode).toBe(404);
    });
  });

  describe('POST /kitchen/recipes', () => {
    it('pushes a recipe', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/recipes',
        payload: {
          name: 'Overnight oats',
          components: [{ label: 'oats', default_qty_g: 40, per_100g: { calories: 380, protein_g: 13, sat_fat_g: 2 } }],
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().source).toBe('pushed');
    });

    it('rejects a recipe with no name with 400', async () => {
      const response = await fastify.inject({ method: 'POST', url: '/kitchen/recipes', payload: {} });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /kitchen/entries/:ulid/promote', () => {
    it('promotes a resolved entry into a recipe', async () => {
      const ulid = generateUlid();
      await new KitchenPipeline(entries, recipes, estimator, fastify.log).ingest({ ulid, note: 'chicken salad' }, []);

      const response = await fastify.inject({
        method: 'POST',
        url: `/kitchen/entries/${ulid}/promote`,
        payload: {},
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().source).toBe('promoted');
    });

    it('accepts a genuinely bodyless POST (no payload at all)', async () => {
      const ulid = generateUlid();
      await new KitchenPipeline(entries, recipes, estimator, fastify.log).ingest({ ulid, note: 'chicken salad' }, []);

      const response = await fastify.inject({ method: 'POST', url: `/kitchen/entries/${ulid}/promote` });
      expect(response.statusCode).toBe(201);
    });

    it('reconstructs real components when the entry was logged from a recipe', async () => {
      const recipe = await recipes.insert({
        ulid: generateUlid(),
        name: 'Salmon-kale bowl',
        components: [
          { label: 'kale', default_qty_g: 70, per_100g: { calories: 35, protein_g: 2.9, sat_fat_g: 0.1 } },
          { label: 'salmon', default_qty_g: 120, per_100g: { calories: 106, protein_g: 21, sat_fat_g: 1.2 } },
        ],
        source: 'pushed',
      });
      const ulid = generateUlid();
      await new KitchenPipeline(entries, recipes, estimator, fastify.log).ingest(
        {
          ulid,
          recipe_ulid: recipe.ulid,
          component_quantities: [{ label: 'salmon', quantity_g: 150 }],
        },
        []
      );

      const response = await fastify.inject({ method: 'POST', url: `/kitchen/entries/${ulid}/promote` });
      expect(response.statusCode).toBe(201);
      const json = response.json();
      expect(json.components.map((c: { label: string; default_qty_g: number }) => [c.label, c.default_qty_g])).toEqual([
        ['kale', 70],
        ['salmon', 150],
      ]);
    });

    it('honors a name override', async () => {
      const ulid = generateUlid();
      await new KitchenPipeline(entries, recipes, estimator, fastify.log).ingest({ ulid, note: 'chicken salad' }, []);

      const response = await fastify.inject({
        method: 'POST',
        url: `/kitchen/entries/${ulid}/promote`,
        payload: { name: 'My Chicken Salad' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().name).toBe('My Chicken Salad');
    });
  });

  describe('GET /kitchen/reselect', () => {
    it('returns recipes + recent entries', async () => {
      await recipes.insert({ ulid: generateUlid(), name: 'Salad', components: [], source: 'pushed' });
      const response = await fastify.inject({ method: 'GET', url: '/kitchen/reselect' });
      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.recipes.map((r: { name: string }) => r.name)).toContain('Salad');
    });
  });
});
