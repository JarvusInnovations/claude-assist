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
});
