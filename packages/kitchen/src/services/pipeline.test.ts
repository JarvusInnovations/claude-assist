import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { MemoryEntryStore, MemoryRecipeStore } from '../memory-store.js';
import { generateUlid } from '../ulid.js';
import type { ModelEstimate } from '../types.js';
import type { Estimator } from './estimator.js';
import {
  KitchenPipeline,
  ManualOverrideConflictError,
  PromoteNotReadyError,
  RecipeNotFoundError,
} from './pipeline.js';

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

/** Scripted fake estimator: yields the next result/throw in `script`, once per call. */
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

class RefusingEstimator implements Estimator {
  called = false;
  async estimate(): Promise<ModelEstimate> {
    this.called = true;
    throw new Error('should never be called for a deterministic path');
  }
}

describe('recipe-computed entries skip the model', () => {
  it('computes macros deterministically and never touches the estimator', async () => {
    const entries = new MemoryEntryStore();
    const recipes = new MemoryRecipeStore();
    const estimator = new RefusingEstimator();
    const pipeline = new KitchenPipeline(entries, recipes, estimator, log);

    const recipe = await recipes.insert({
      ulid: generateUlid(),
      name: 'Oatmeal',
      components: [{ label: 'oats', default_qty_g: 50, per_100g: { calories: 380, protein_g: 13, sat_fat_g: 2 } }],
      source: 'pushed',
    });

    const ulid = generateUlid();
    const { record, created } = await pipeline.ingest(
      { ulid, recipe_ulid: recipe.ulid },
      []
    );

    expect(created).toBe(true);
    expect(record.status).toBe('estimated');
    expect(record.source).toBe('reselect');
    expect(record.label).toBe('Oatmeal');
    expect(record.calories).toBeCloseTo(190, 1); // 380 * 0.5
    expect(estimator.called).toBe(false);
  });

  it('rejects an entry referencing an unknown recipe', async () => {
    const pipeline = new KitchenPipeline(new MemoryEntryStore(), new MemoryRecipeStore(), null, log);
    await expect(
      pipeline.ingest({ ulid: generateUlid(), recipe_ulid: generateUlid() }, [])
    ).rejects.toThrow(RecipeNotFoundError);
  });
});

describe('estimation queue (mocked model)', () => {
  it('calls the estimator immediately for a photo/note entry and lands on estimated/model', async () => {
    const entries = new MemoryEntryStore();
    const estimator = new ScriptedEstimator([mkModelEstimate()]);
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), estimator, log);

    const ingested = await pipeline.ingest({ ulid: generateUlid(), note: 'chicken salad' }, []);
    await ingested.estimation;
    const record = (await pipeline.get(ingested.record.ulid))!;

    expect(record.status).toBe('estimated');
    expect(record.source).toBe('model');
    expect(record.label).toBe('Grilled chicken salad');
    expect(record.calories).toBe(450);
    expect(estimator.calls).toBe(1);
  });

  it('leaves the entry estimating without burning an attempt when no estimator is configured', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);

    const ingested = await pipeline.ingest({ ulid: generateUlid(), note: 'mystery leftovers' }, []);
    await ingested.estimation;
    const record = (await pipeline.get(ingested.record.ulid))!;

    expect(record.status).toBe('estimating');
    expect(record.estimate_attempts).toBe(0);
  });

  it('caps attempts and moves to failed after MAX_ATTEMPTS sweep failures', async () => {
    const entries = new MemoryEntryStore();
    const estimator = new ScriptedEstimator([new Error('rate limited')]);
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), estimator, log, { batchSize: 10 });

    const ingested = await pipeline.ingest({ ulid: generateUlid(), note: 'unknown dish' }, []);
    await ingested.estimation;
    const record = (await pipeline.get(ingested.record.ulid))!;
    expect(record.status).toBe('estimating');
    expect(record.estimate_attempts).toBe(1);

    // Sweep repeatedly until attempts are exhausted (MAX_ATTEMPTS = 5; one attempt already spent above).
    for (let i = 0; i < KitchenPipeline.MAX_ATTEMPTS; i++) {
      await pipeline.sweep();
    }

    const final = await pipeline.get(record.ulid);
    expect(final!.status).toBe('failed');
    expect(final!.estimate_attempts).toBe(KitchenPipeline.MAX_ATTEMPTS);
  });

  it('idempotent replay while estimating retries with the freshly supplied photos', async () => {
    const entries = new MemoryEntryStore();
    const estimator = new ScriptedEstimator([new Error('transient'), mkModelEstimate()]);
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), estimator, log);

    const ulid = generateUlid();
    const first = await pipeline.ingest({ ulid, note: 'leftover pasta' }, []);
    await first.estimation;
    expect(first.created).toBe(true);
    const afterFirst = await pipeline.get(ulid);
    expect(afterFirst!.status).toBe('estimating');
    expect(afterFirst!.estimate_attempts).toBe(1);

    const replay = await pipeline.ingest({ ulid, note: 'leftover pasta' }, [
      { data: Buffer.from('fake-jpeg-bytes'), mimeType: 'image/jpeg' },
    ]);
    await replay.estimation;
    expect(replay.created).toBe(false); // idempotent — not a new row
    const afterReplay = await pipeline.get(ulid);
    expect(afterReplay!.status).toBe('estimated');
    expect(afterReplay!.source).toBe('model');
    expect(estimator.calls).toBe(2);
  });

  it('a replay after the entry is already estimated does not re-invoke the estimator', async () => {
    const entries = new MemoryEntryStore();
    const estimator = new ScriptedEstimator([mkModelEstimate()]);
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), estimator, log);

    const ulid = generateUlid();
    const first = await pipeline.ingest({ ulid, note: 'chicken salad' }, []);
    await first.estimation;
    expect(estimator.calls).toBe(1);

    const replay = await pipeline.ingest({ ulid, note: 'drifted text should be ignored' }, []);
    expect(replay.created).toBe(false);
    expect(estimator.calls).toBe(1); // no re-invocation once resolved
    expect(replay.record.note).toBe('chicken salad'); // first write wins
  });
});

describe('sheet-sourced recipes', () => {
  it('logs an entry against a sheet recipe (read-through, no DB row)', async () => {
    const entries = new MemoryEntryStore();
    const recipes = new MemoryRecipeStore();
    const sheetRecipe = {
      ulid: '01SHEET0000000000000000000',
      name: 'Salmon-kale bowl',
      components: [
        { label: 'kale', default_qty_g: 70, per_100g: { calories: 35, protein_g: 2.9, sat_fat_g: 0.1 } },
        { label: 'salmon', default_qty_g: 120, per_100g: { calories: 106, protein_g: 21, sat_fat_g: 1.2 } },
      ],
      source: 'sheet' as const,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const pipeline = new KitchenPipeline(entries, recipes, null, log, {
      readSheetRecipes: async () => [sheetRecipe],
    });

    const { record, created } = await pipeline.ingest(
      { ulid: generateUlid(), recipe_ulid: sheetRecipe.ulid },
      []
    );
    expect(created).toBe(true);
    const after = await pipeline.get(record.ulid);
    expect(after!.status).toBe('estimated');
    expect(after!.source).toBe('reselect');
    expect(after!.label).toBe('Salmon-kale bowl');
    expect(after!.calories).toBeGreaterThan(0);
  });
});

describe('manual override — terminal semantics', () => {
  it('a macro override sets source manual and status estimated from any prior state', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);

    const { record } = await pipeline.ingest({ ulid: generateUlid(), note: 'mystery bowl' }, []);
    expect(record.status).toBe('estimating');

    const updated = await pipeline.patch(record.ulid, { calories: 500, protein_g: 40, label: 'Homemade bowl' });
    expect(updated!.status).toBe('estimated');
    expect(updated!.source).toBe('manual');
    expect(updated!.calories).toBe(500);
    expect(updated!.protein_g).toBe(40);
    expect(updated!.label).toBe('Homemade bowl');
  });

  it('rejects a later note/label edit on a manual entry with a 409-shaped error', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);

    const { record } = await pipeline.ingest({ ulid: generateUlid(), note: 'mystery bowl' }, []);
    await pipeline.patch(record.ulid, { calories: 500 });

    await expect(pipeline.patch(record.ulid, { note: 'trying to reopen this' })).rejects.toThrow(
      ManualOverrideConflictError
    );
  });

  it('a note/label-only edit re-queues estimation and re-attempts immediately', async () => {
    const entries = new MemoryEntryStore();
    const estimator = new ScriptedEstimator([mkModelEstimate({ label: 'first guess' }), mkModelEstimate({ label: 'second guess' })]);
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), estimator, log);

    const ingested = await pipeline.ingest({ ulid: generateUlid(), note: 'something' }, []);
    await ingested.estimation;
    expect((await pipeline.get(ingested.record.ulid))!.label).toBe('first guess');

    await pipeline.patch(ingested.record.ulid, { note: 'actually it was pizza' });
    await pipeline.settle();
    const updated = await pipeline.get(ingested.record.ulid);
    expect(updated!.status).toBe('estimated');
    expect(updated!.label).toBe('second guess');
    expect(updated!.note).toBe('actually it was pizza');
    expect(estimator.calls).toBe(2);
  });
});

describe('promote', () => {
  it('creates a recipe from a resolved entry', async () => {
    const entries = new MemoryEntryStore();
    const estimator = new ScriptedEstimator([mkModelEstimate({ label: 'Turkey sandwich', calories: 380 })]);
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), estimator, log);

    const { record } = await pipeline.ingest({ ulid: generateUlid(), note: 'turkey sandwich' }, []);
    const recipe = await pipeline.promote(record.ulid);

    expect(recipe!.name).toBe('Turkey sandwich');
    expect(recipe!.source).toBe('promoted');
    expect(recipe!.components).toHaveLength(1);
    expect(recipe!.components[0]!.per_100g.calories).toBe(380);
  });

  it('refuses to promote an entry with no resolved nutrition yet', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);
    const { record } = await pipeline.ingest({ ulid: generateUlid(), note: 'still estimating' }, []);
    await expect(pipeline.promote(record.ulid)).rejects.toThrow(PromoteNotReadyError);
  });
});

describe('promote — real component reconstruction', () => {
  const bowlComponents = [
    { label: 'kale', default_qty_g: 70, per_100g: { calories: 35, protein_g: 2.9, sat_fat_g: 0.1 } },
    { label: 'salmon', default_qty_g: 120, per_100g: { calories: 106, protein_g: 21, sat_fat_g: 1.2 } },
  ];

  async function seedRecipeEntry(
    entries: MemoryEntryStore,
    recipes: MemoryRecipeStore,
    quantities: Array<{ label: string; quantity_g: number }>
  ) {
    const pipeline = new KitchenPipeline(entries, recipes, null, log);
    const recipe = await recipes.insert({
      ulid: generateUlid(),
      name: 'Salmon-kale bowl',
      components: structuredClone(bowlComponents),
      source: 'pushed',
    });
    const { record } = await pipeline.ingest(
      { ulid: generateUlid(), recipe_ulid: recipe.ulid, component_quantities: quantities },
      []
    );
    return { pipeline, recipe, record };
  }

  it('reconstructs the source recipe components with logged quantities as new defaults', async () => {
    const entries = new MemoryEntryStore();
    const recipes = new MemoryRecipeStore();
    const { pipeline, record } = await seedRecipeEntry(entries, recipes, [
      { label: 'kale', quantity_g: 50 },
      { label: 'salmon', quantity_g: 150 },
    ]);

    const promoted = await pipeline.promote(record.ulid, 'My bowl');
    expect(promoted!.source).toBe('promoted');
    expect(promoted!.components).toEqual([
      { label: 'kale', default_qty_g: 50, per_100g: { calories: 35, protein_g: 2.9, sat_fat_g: 0.1 } },
      { label: 'salmon', default_qty_g: 150, per_100g: { calories: 106, protein_g: 21, sat_fat_g: 1.2 } },
    ]);
  });

  it('carries source defaults for components the entry did not quantify', async () => {
    const entries = new MemoryEntryStore();
    const recipes = new MemoryRecipeStore();
    // Only salmon logged explicitly — kale contributed at its default at
    // ingest, so it must survive at that default (dropping it would make
    // the promoted recipe understate the meal).
    const { pipeline, record } = await seedRecipeEntry(entries, recipes, [
      { label: 'salmon', quantity_g: 150 },
    ]);

    const promoted = await pipeline.promote(record.ulid);
    expect(promoted!.components.map((c) => [c.label, c.default_qty_g])).toEqual([
      ['kale', 70],
      ['salmon', 150],
    ]);
  });

  it('reconstructs from a sheet recipe (read-through, no DB row)', async () => {
    const entries = new MemoryEntryStore();
    const recipes = new MemoryRecipeStore();
    const sheetRecipe = {
      ulid: '01SHEET0000000000000000000',
      name: 'Sheet bowl',
      components: structuredClone(bowlComponents),
      source: 'sheet' as const,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const pipeline = new KitchenPipeline(entries, recipes, null, log, {
      readSheetRecipes: async () => [sheetRecipe],
    });

    const { record } = await pipeline.ingest(
      {
        ulid: generateUlid(),
        recipe_ulid: sheetRecipe.ulid,
        component_quantities: [{ label: 'kale', quantity_g: 90 }],
      },
      []
    );

    const promoted = await pipeline.promote(record.ulid);
    expect(promoted!.components.map((c) => [c.label, c.default_qty_g])).toEqual([
      ['kale', 90],
      ['salmon', 120],
    ]);
  });

  it('falls back to the synthetic component when a quantity label matches no source component', async () => {
    const entries = new MemoryEntryStore();
    const recipes = new MemoryRecipeStore();
    // 'tofu' matches nothing — indistinguishable from source-recipe drift,
    // so the whole reconstruction is abandoned for the truthful synthetic
    // total (see reconstructComponents).
    const { pipeline, record } = await seedRecipeEntry(entries, recipes, [
      { label: 'kale', quantity_g: 50 },
      { label: 'tofu', quantity_g: 100 },
    ]);

    const promoted = await pipeline.promote(record.ulid);
    const stored = (await pipeline.get(record.ulid))!;
    expect(promoted!.components).toHaveLength(1);
    expect(promoted!.components[0]!.default_qty_g).toBe(100);
    expect(promoted!.components[0]!.per_100g.calories).toBe(stored.calories!);
  });

  it('falls back to the synthetic component when the source recipe was deleted', async () => {
    const entries = new MemoryEntryStore();
    const recipes = new MemoryRecipeStore();
    const { pipeline, recipe, record } = await seedRecipeEntry(entries, recipes, [
      { label: 'salmon', quantity_g: 150 },
    ]);
    recipes.records.delete(recipe.ulid);

    const promoted = await pipeline.promote(record.ulid);
    const stored = (await pipeline.get(record.ulid))!;
    expect(promoted!.components).toHaveLength(1);
    expect(promoted!.components[0]!.per_100g.calories).toBe(stored.calories!);
  });

  it('falls back to the synthetic component after a manual override (the correction is terminal)', async () => {
    const entries = new MemoryEntryStore();
    const recipes = new MemoryRecipeStore();
    const { pipeline, record } = await seedRecipeEntry(entries, recipes, [
      { label: 'kale', quantity_g: 50 },
      { label: 'salmon', quantity_g: 150 },
    ]);
    await pipeline.patch(record.ulid, { calories: 999 });

    const promoted = await pipeline.promote(record.ulid);
    // Real components would resurrect the pre-correction macros; the
    // synthetic component carries the owner's corrected totals instead.
    expect(promoted!.components).toHaveLength(1);
    expect(promoted!.components[0]!.per_100g.calories).toBe(999);
  });
});

describe('reselect comment carry', () => {
  it('persists a note submitted with a recipe-sourced entry', async () => {
    const entries = new MemoryEntryStore();
    const recipes = new MemoryRecipeStore();
    const pipeline = new KitchenPipeline(entries, recipes, null, log);
    const recipe = await recipes.insert({
      ulid: generateUlid(),
      name: 'Oatmeal',
      components: [{ label: 'oats', default_qty_g: 50, per_100g: { calories: 380, protein_g: 13, sat_fat_g: 2 } }],
      source: 'pushed',
    });

    const { record } = await pipeline.ingest(
      { ulid: generateUlid(), recipe_ulid: recipe.ulid, note: 'extra cinnamon this time' },
      []
    );

    expect(record.note).toBe('extra cinnamon this time');
    const stored = await pipeline.get(record.ulid);
    expect(stored!.note).toBe('extra cinnamon this time');
    expect(stored!.status).toBe('estimated');
    expect(stored!.source).toBe('reselect');
    expect(stored!.label).toBe('Oatmeal'); // the note annotates, never replaces, the label
  });
});

describe('reselect merge logic', () => {
  it('merges sheet + pushed/promoted recipes with recent logged items', async () => {
    const entries = new MemoryEntryStore();
    const recipes = new MemoryRecipeStore();
    const estimator = new ScriptedEstimator([mkModelEstimate({ label: 'Yogurt bowl' })]);
    const sheetRecipe = {
      ulid: generateUlid(),
      name: 'Sheet Oatmeal',
      components: [],
      source: 'sheet' as const,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const pipeline = new KitchenPipeline(entries, recipes, estimator, log, {
      readSheetRecipes: async () => [sheetRecipe],
    });

    await recipes.insert({ ulid: generateUlid(), name: 'Pushed Salad', components: [], source: 'pushed' });
    await pipeline.ingest({ ulid: generateUlid(), note: 'yogurt' }, []);

    const strip = await pipeline.reselect();
    expect(strip.recipes.map((r) => r.name)).toEqual(expect.arrayContaining(['Sheet Oatmeal', 'Pushed Salad']));
    expect(strip.recent.map((r) => r.label)).toContain('Yogurt bowl');
  });

  it('degrades to recents-only when no sheet reader is configured', async () => {
    const pipeline = new KitchenPipeline(new MemoryEntryStore(), new MemoryRecipeStore(), null, log);
    const strip = await pipeline.reselect();
    expect(strip.recipes).toEqual([]);
    expect(strip.recent).toEqual([]);
  });

  it('listAllRecipes returns the merged sheet + DB view (backs fastify.kitchenRecipes)', async () => {
    const recipes = new MemoryRecipeStore();
    const sheetRecipe = {
      ulid: generateUlid(),
      name: 'Sheet Greek Bowl',
      components: [
        { label: 'feta', default_qty_g: 50, per_100g: { calories: 260, protein_g: 14, sat_fat_g: 15 } },
      ],
      source: 'sheet' as const,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const pipeline = new KitchenPipeline(new MemoryEntryStore(), recipes, null, log, {
      readSheetRecipes: async () => [sheetRecipe],
    });
    await recipes.insert({ ulid: generateUlid(), name: 'Pushed Salad', components: [], source: 'pushed' });

    const all = await pipeline.listAllRecipes();
    expect(all.map((r) => r.name)).toEqual(expect.arrayContaining(['Sheet Greek Bowl', 'Pushed Salad']));
    // A sheet-only recipe carries its component labels through the merged view.
    expect(all.find((r) => r.name === 'Sheet Greek Bowl')!.components.map((c) => c.label)).toEqual(['feta']);
  });
});
