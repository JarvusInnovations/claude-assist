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
    sugar_g: 6,
    added_sugar_g: 1,
    fiber_g: 4,
    sodium_mg: 700,
    confidence: 0.55,
    portion_basis: 'one plate',
    excluded: [],
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

    // ── reselect_of: clone a source entry deterministically (recent pills) ──

    /** Seed an estimated source entry to clone from. */
    async function seedSource(label = 'Cottage cheese bowl'): Promise<string> {
      const sourceUlid = generateUlid();
      await entries.insertIfAbsent({
        ulid: sourceUlid,
        logged_at: new Date(),
        note: null,
        recipe_ulid: null,
        component_quantities: null,
      notes_reviewed: true,
      });
      await entries.applyEstimate(
        sourceUlid,
        label,
        {
          calories: 220,
          protein_g: 24,
          fat_g: 5,
          sat_fat_g: 3,
          carbs_g: 12,
          sugar_g: null,
          added_sugar_g: null,
          fiber_g: null,
          sodium_mg: 400,
          confidence: 0.5,
          portion_basis: 'one bowl',
        },
        'model',
        'estimated'
      );
      return sourceUlid;
    }

    it('clones a source entry via reselect_of (estimated, source reselect, exact base macros, no model call)', async () => {
      const sourceUlid = await seedSource();
      const ulid = generateUlid();
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid, reselect_of: sourceUlid }),
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
      expect(json.label).toBe('Cottage cheese bowl');
      expect(json.calories).toBe(220);
      expect(json.protein_g).toBe(24);
      expect(json.sodium_mg).toBe(400);
      expect(json.portion_multiplier).toBe(1); // never cloned — fresh serving
      expect(estimator.calls).toBe(0);
    });

    it('stores a comment riding a reselect_of clone and never invokes the model', async () => {
      const sourceUlid = await seedSource();
      const ulid = generateUlid();
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid, reselect_of: sourceUlid, note: 'smaller portion' }),
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().note).toBe('smaller portion');

      const after = await fastify.inject({ method: 'GET', url: `/kitchen/entries/${ulid}` });
      expect(after.json().note).toBe('smaller portion');
      expect(after.json().source).toBe('reselect');
      expect(estimator.calls).toBe(0);
    });

    it('rejects a POST carrying both recipe_ulid and reselect_of with 400', async () => {
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({
          ulid: generateUlid(),
          recipe_ulid: generateUlid(),
          reselect_of: generateUlid(),
        }),
      });
      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects reselect_of referencing an unknown/deleted source entry with 400', async () => {
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid: generateUlid(), reselect_of: generateUlid() }),
      });
      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('unknown source entry');
    });

    it('rejects a malformed reselect_of (not a ULID) with 400', async () => {
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid: generateUlid(), reselect_of: 'not-a-ulid' }),
      });
      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });
      expect(response.statusCode).toBe(400);
    });

    // ── macros: directly-stated panel (born-manual, terminal, no estimation) ──

    const FULL_PANEL = {
      calories: 620,
      protein_g: 41,
      fat_g: 22,
      sat_fat_g: 7,
      carbs_g: 58,
      sugar_g: 12,
      added_sugar_g: 4,
      fiber_g: 9,
      sodium_mg: 880,
    };

    it('stores a directly-stated panel verbatim: born manual/estimated, no model call', async () => {
      const ulid = generateUlid();
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid, macros: FULL_PANEL, label: 'test bowl' }),
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
      expect(json.source).toBe('manual');
      expect(json.label).toBe('test bowl');
      expect(json.calories).toBe(620);
      expect(json.protein_g).toBe(41);
      expect(json.fat_g).toBe(22);
      expect(json.sat_fat_g).toBe(7);
      expect(json.carbs_g).toBe(58);
      expect(json.sugar_g).toBe(12);
      expect(json.added_sugar_g).toBe(4);
      expect(json.fiber_g).toBe(9);
      expect(json.sodium_mg).toBe(880);
      expect(json.confidence).toBeNull();
      expect(json.portion_basis).toBeNull();
      expect(json.portion_multiplier).toBe(1);

      await pipeline.settle();
      expect(estimator.calls).toBe(0); // the load-bearing invariant
    });

    it('persists unstated panel fields as null, not 0', async () => {
      const ulid = generateUlid();
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid, macros: { calories: 200, protein_g: 15 } }),
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });
      expect(response.statusCode).toBe(201);
      const json = response.json();
      expect(json.calories).toBe(200);
      expect(json.protein_g).toBe(15);
      expect(json.fat_g).toBeNull();
      expect(json.sat_fat_g).toBeNull();
      expect(json.sodium_mg).toBeNull();
      expect(json.fat_g).not.toBe(0);
    });

    it('rejects macros combined with recipe_ulid with 400', async () => {
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid: generateUlid(), macros: FULL_PANEL, recipe_ulid: generateUlid() }),
      });
      const response = await fastify.inject({ method: 'POST', url: '/kitchen/entries', headers: { 'content-type': contentType }, payload: body });
      expect(response.statusCode).toBe(400);
    });

    it('rejects macros combined with reselect_of with 400', async () => {
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid: generateUlid(), macros: FULL_PANEL, reselect_of: generateUlid() }),
      });
      const response = await fastify.inject({ method: 'POST', url: '/kitchen/entries', headers: { 'content-type': contentType }, payload: body });
      expect(response.statusCode).toBe(400);
    });

    it('rejects macros combined with component quantities with 400', async () => {
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid: generateUlid(), macros: FULL_PANEL, component_quantities: [{ label: 'rice', quantity_g: 100 }] }),
      });
      const response = await fastify.inject({ method: 'POST', url: '/kitchen/entries', headers: { 'content-type': contentType }, payload: body });
      expect(response.statusCode).toBe(400);
    });

    it('rejects macros combined with a photo part with 400', async () => {
      const ulid = generateUlid();
      const { body, contentType } = buildMultipart(
        { entry: JSON.stringify({ ulid, macros: FULL_PANEL }) },
        [{ fieldname: 'photo', filename: 'meal.jpg', contentType: 'image/jpeg', data: Buffer.from('fake-jpeg-bytes') }]
      );
      const response = await fastify.inject({ method: 'POST', url: '/kitchen/entries', headers: { 'content-type': contentType }, payload: body });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('photo');
    });

    it('rejects an unknown key inside macros with 400', async () => {
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid: generateUlid(), macros: { calories: 100, protien_g: 20 } }),
      });
      const response = await fastify.inject({ method: 'POST', url: '/kitchen/entries', headers: { 'content-type': contentType }, payload: body });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('unknown field');
    });

    it('rejects a non-numeric macros field with 400', async () => {
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid: generateUlid(), macros: { calories: 'lots' } }),
      });
      const response = await fastify.inject({ method: 'POST', url: '/kitchen/entries', headers: { 'content-type': contentType }, payload: body });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a label sent without a macros panel with 400', async () => {
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid: generateUlid(), note: 'chicken salad', label: 'sneaky label' }),
      });
      const response = await fastify.inject({ method: 'POST', url: '/kitchen/entries', headers: { 'content-type': contentType }, payload: body });
      expect(response.statusCode).toBe(400);
    });

    it('is idempotent on ULID: replaying a born-manual POST is a no-op', async () => {
      const ulid = generateUlid();
      const first = buildMultipart({ entry: JSON.stringify({ ulid, macros: FULL_PANEL, label: 'test bowl' }) });
      const created = await fastify.inject({ method: 'POST', url: '/kitchen/entries', headers: { 'content-type': first.contentType }, payload: first.body });
      expect(created.statusCode).toBe(201);

      // Replay carrying different numbers must not overwrite — first write wins.
      const second = buildMultipart({ entry: JSON.stringify({ ulid, macros: { calories: 1 }, label: 'other' }) });
      const replay = await fastify.inject({ method: 'POST', url: '/kitchen/entries', headers: { 'content-type': second.contentType }, payload: second.body });
      expect(replay.statusCode).toBe(200);
      const json = replay.json();
      expect(json.calories).toBe(620);
      expect(json.label).toBe('test bowl');
      expect(json.source).toBe('manual');
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

    it('accepts an added_sugar_g override on the wire and returns it on the row', async () => {
      // The route schema is additionalProperties:false, so this is the test that
      // the ninth field is actually patchable end-to-end rather than 400-ing —
      // the correction path for an entry whose added sugar was left unknown.
      const ulid = generateUlid();
      const seedPipeline = new KitchenPipeline(entries, recipes, estimator, fastify.log);
      const { estimation } = await seedPipeline.ingest({ ulid, note: 'whole fruit' }, []);
      await estimation;

      const response = await fastify.inject({
        method: 'PATCH',
        url: `/kitchen/entries/${ulid}`,
        payload: { added_sugar_g: 0 },
      });
      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.added_sugar_g).toBe(0);
      expect(json.source).toBe('manual');
      expect(json.ulid).toBe(ulid);
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

    // specs/modules/kitchen.md § Request validation is strict, not permissive
    // — the same silent-strip defect fixed on the products PATCH applies to
    // every schema-validated body in the module (Fastify's default AJV
    // compiler removes an unmatched key instead of rejecting it); this proves
    // the fix is installed here too, not just on the route that got reported.
    it('rejects an unrecognized body key rather than silently dropping it', async () => {
      const ulid = generateUlid();
      await new KitchenPipeline(entries, recipes, estimator, fastify.log).ingest({ ulid, note: 'x' }, []);

      const response = await fastify.inject({
        method: 'PATCH',
        url: `/kitchen/entries/${ulid}`,
        payload: { calories: 300, notes: 'typo for note' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('"notes"');
      expect(response.json().error).toContain('note');
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

    it('UPSERTS on the normalized name — a correction replaces, it never forks', async () => {
      const push = (payload: Record<string, unknown>) =>
        fastify.inject({ method: 'POST', url: '/kitchen/recipes', payload });

      const first = await push({
        name: 'Oat jar',
        components: [{ label: 'oats', default_qty_g: 40, per_100g: { calories: 380, protein_g: 13, sat_fat_g: 2 } }],
      });
      expect(first.statusCode).toBe(201);
      const ulid = first.json().ulid;

      // The correction: same name (differently cased/spaced — nobody tapping a
      // pill could tell them apart), better numbers.
      const corrected = await push({
        name: '  oat   JAR ',
        components: [{ label: 'oats', default_qty_g: 80, per_100g: { calories: 380, protein_g: 13, sat_fat_g: 2 } }],
      });
      expect(corrected.statusCode).toBe(200); // replaced, not created
      expect(corrected.json().ulid).toBe(ulid); // same record — identity survives
      expect(corrected.json().components[0].default_qty_g).toBe(80);

      // One recipe, one pill: the whole point.
      const strip = await fastify.inject({ method: 'GET', url: '/kitchen/reselect' });
      expect(strip.json().recipes.filter((r: { ulid: string }) => r.ulid === ulid)).toHaveLength(1);
      expect(strip.json().recipes).toHaveLength(1);
    });

    it('replaces a specific record by explicit ulid, preserving its source, and creates when absent', async () => {
      const promoted = await recipes.insert({
        ulid: generateUlid(),
        name: 'Promoted bowl',
        components: [],
        source: 'promoted',
      });

      // An explicit ulid is explicit intent — it may replace a promoted record.
      const replaced = await fastify.inject({
        method: 'POST',
        url: '/kitchen/recipes',
        payload: { ulid: promoted.ulid, name: 'Promoted bowl v2', components: [] },
      });
      expect(replaced.statusCode).toBe(200);
      expect(replaced.json().ulid).toBe(promoted.ulid);
      expect(replaced.json().name).toBe('Promoted bowl v2');
      expect(replaced.json().source).toBe('promoted'); // NOT re-founded as pushed

      // A ulid that doesn't exist yet creates it (idempotent-on-ulid, like
      // inventory add) — and a replay is a replace, never a duplicate.
      const seeded = generateUlid();
      const created = await fastify.inject({
        method: 'POST',
        url: '/kitchen/recipes',
        payload: { ulid: seeded, name: 'Seeded jar', components: [] },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().ulid).toBe(seeded);
      const replay = await fastify.inject({
        method: 'POST',
        url: '/kitchen/recipes',
        payload: { ulid: seeded, name: 'Seeded jar', components: [] },
      });
      expect(replay.statusCode).toBe(200);
      expect((await recipes.list({})).filter((r) => r.name === 'Seeded jar')).toHaveLength(1);
    });

    it('409s rather than clobbering a promoted recipe via a name collision', async () => {
      const promoted = await recipes.insert({
        ulid: generateUlid(),
        name: 'Promoted bowl',
        components: [],
        source: 'promoted',
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/recipes',
        payload: { name: 'promoted BOWL', components: [] },
      });
      expect(response.statusCode).toBe(409);
      // The error has to be actionable: it names what it collided with, and both
      // ways forward.
      expect(response.json().error).toContain(promoted.ulid);
      expect(response.json().error).toContain('promoted');
      expect(response.json().error).toContain('ulid');
      // Nothing was written.
      expect(await recipes.list({})).toHaveLength(1);
    });

    it('409s on a collision with a sheet-sourced recipe (the sheet is never written from here)', async () => {
      // A dedicated app so the pipeline reads a sheet projection.
      const app = Fastify({ logger: false });
      const sheetRecipe = {
        ulid: generateUlid(),
        name: 'Sheet bowl',
        components: [],
        source: 'sheet' as const,
        created_at: new Date(),
        updated_at: new Date(),
        archived_at: null,
      };
      const sheetRecipes = new MemoryRecipeStore();
      await app.register(registerKitchenRoutes, {
        pipeline: new KitchenPipeline(new MemoryEntryStore(), sheetRecipes, null, app.log, {
          readSheetRecipes: async () => [sheetRecipe],
        }),
      });
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/kitchen/recipes',
        payload: { name: 'sheet bowl', components: [] },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('sheet');
      expect(await sheetRecipes.list({})).toHaveLength(0);
      await app.close();
    });

    it('409s naming every candidate when duplicate pushed forks already share a name', async () => {
      // The pre-upsert state of the world: two same-named forks. The upsert must
      // not guess which one is canonical.
      const a = await recipes.insert({ ulid: generateUlid(), name: 'Twin jar', components: [], source: 'pushed' });
      const b = await recipes.insert({ ulid: generateUlid(), name: 'twin jar', components: [], source: 'pushed' });

      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/recipes',
        payload: { name: 'Twin jar', components: [] },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain(a.ulid);
      expect(response.json().error).toContain(b.ulid);
    });
  });

  describe('DELETE /kitchen/recipes/:ulid', () => {
    it('archives: off the strip for good, still resolvable so history never dangles', async () => {
      const recipe = await recipes.insert({
        ulid: generateUlid(),
        name: 'Retired jar',
        components: [{ label: 'oats', default_qty_g: 40, per_100g: { calories: 380, protein_g: 13, sat_fat_g: 2 } }],
        source: 'pushed',
      });
      // An entry logged from it — the thing that must not break.
      const entryUlid = generateUlid();
      await new KitchenPipeline(entries, recipes, estimator, fastify.log).ingest(
        { ulid: entryUlid, recipe_ulid: recipe.ulid },
        []
      );

      const response = await fastify.inject({ method: 'DELETE', url: `/kitchen/recipes/${recipe.ulid}` });
      expect(response.statusCode).toBe(200);
      expect(response.json().archived_at).toBeTruthy();

      // Gone from the strip and every merged listing — cannot be tapped again.
      const strip = await fastify.inject({ method: 'GET', url: '/kitchen/reselect' });
      expect(strip.json().recipes.map((r: { ulid: string }) => r.ulid)).not.toContain(recipe.ulid);

      // Still resolvable by ULID, so a re-log of the historical entry and a
      // promote's component reconstruction both still work.
      expect(await recipes.get(recipe.ulid)).not.toBeNull();
      const { body, contentType } = buildMultipart({
        entry: JSON.stringify({ ulid: generateUlid(), recipe_ulid: recipe.ulid }),
      });
      const relog = await fastify.inject({
        method: 'POST',
        url: '/kitchen/entries',
        headers: { 'content-type': contentType },
        payload: body,
      });
      expect(relog.statusCode).toBe(201);
      const promote = await fastify.inject({ method: 'POST', url: `/kitchen/entries/${entryUlid}/promote` });
      expect(promote.statusCode).toBe(201);
    });

    it('is idempotent, and 404s an unknown ulid (a sheet recipe has no row to archive)', async () => {
      const recipe = await recipes.insert({ ulid: generateUlid(), name: 'Twice', components: [], source: 'pushed' });

      const first = await fastify.inject({ method: 'DELETE', url: `/kitchen/recipes/${recipe.ulid}` });
      expect(first.statusCode).toBe(200);
      const again = await fastify.inject({ method: 'DELETE', url: `/kitchen/recipes/${recipe.ulid}` });
      expect(again.statusCode).toBe(200);
      // The original stamp survives — a repeat archive is not a re-archive.
      expect(again.json().archived_at).toBe(first.json().archived_at);

      const missing = await fastify.inject({ method: 'DELETE', url: `/kitchen/recipes/${generateUlid()}` });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toContain('Sheet-sourced');
    });

    it('an archived name is free again — the next push creates rather than 409ing', async () => {
      const recipe = await recipes.insert({ ulid: generateUlid(), name: 'Reused name', components: [], source: 'promoted' });
      await fastify.inject({ method: 'DELETE', url: `/kitchen/recipes/${recipe.ulid}` });

      const response = await fastify.inject({
        method: 'POST',
        url: '/kitchen/recipes',
        payload: { name: 'Reused name', components: [] },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().ulid).not.toBe(recipe.ulid);
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

    it('each recent item carries entry_ulid — the source a recent pill clones', async () => {
      const sourceUlid = generateUlid();
      await entries.insertIfAbsent({
        ulid: sourceUlid,
        logged_at: new Date(),
        note: null,
        recipe_ulid: null,
        component_quantities: null,
      notes_reviewed: true,
      });
      await entries.applyEstimate(
        sourceUlid,
        'Latte',
        {
          calories: 130,
          protein_g: 8,
          fat_g: 5,
          sat_fat_g: 3,
          carbs_g: 13,
          sugar_g: null,
          added_sugar_g: null,
          fiber_g: null,
          sodium_mg: 105,
          confidence: 0.5,
          portion_basis: 'grande',
        },
        'model',
        'estimated'
      );

      const response = await fastify.inject({ method: 'GET', url: '/kitchen/reselect' });
      const json = response.json();
      const recent = json.recent.find((r: { label: string }) => r.label === 'Latte');
      expect(recent).toBeDefined();
      expect(recent.entry_ulid).toBe(sourceUlid);
    });
  });
});
