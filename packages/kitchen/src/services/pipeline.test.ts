import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { MemoryEntryStore, MemoryRecipeStore } from '../memory-store.js';
import { generateUlid } from '../ulid.js';
import type { ModelEstimate } from '../types.js';
import type { Estimator } from './estimator.js';
import {
  ConflictingSourceError,
  KitchenPipeline,
  ManualOverrideConflictError,
  PatchValidationError,
  PromoteNotReadyError,
  RecipeNotFoundError,
  SourceEntryNotFoundError,
} from './pipeline.js';
import type { NutritionFields } from '../types.js';

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
    sugar_g: 6,
    fiber_g: 4,
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

describe('portion multiplier — post-hoc base rescale', () => {
  const PORTION_MULTIPLIER_MAX = 20;

  it('defaults to 1 on a fresh entry (wire byte-identical for the unscaled case)', async () => {
    const entries = new MemoryEntryStore();
    const estimator = new ScriptedEstimator([mkModelEstimate()]);
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), estimator, log);

    const { record, estimation } = await pipeline.ingest({ ulid: generateUlid(), note: 'salad' }, []);
    expect(record.portion_multiplier).toBe(1);
    await estimation;
    const after = await pipeline.get(record.ulid);
    expect(after!.portion_multiplier).toBe(1);
  });

  it('a multiplier PATCH on a model entry leaves base macros + source + status untouched', async () => {
    const entries = new MemoryEntryStore();
    const estimator = new ScriptedEstimator([mkModelEstimate({ calories: 800, protein_g: 40, sat_fat_g: 10 })]);
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), estimator, log);

    const ingested = await pipeline.ingest({ ulid: generateUlid(), note: 'loaded fries' }, []);
    await ingested.estimation;
    const base = await pipeline.get(ingested.record.ulid);
    expect(base!.source).toBe('model');

    const updated = await pipeline.patch(ingested.record.ulid, { portion_multiplier: 0.5 });
    // Multiplier stored; the model call was NOT re-run; source/status/base unchanged.
    expect(updated!.portion_multiplier).toBe(0.5);
    expect(updated!.calories).toBe(800); // BASE, unscaled on the wire
    expect(updated!.protein_g).toBe(40);
    expect(updated!.sat_fat_g).toBe(10);
    expect(updated!.source).toBe('model');
    expect(updated!.status).toBe('estimated');
    expect(estimator.calls).toBe(1); // no re-queue

    // effective = base * multiplier, computed by the consumer
    expect(updated!.calories! * updated!.portion_multiplier).toBe(400);
  });

  it('re-PATCH always rescales from base — 0.5 then 0.75 yields 0.75×base, never 0.375×base', async () => {
    const entries = new MemoryEntryStore();
    const estimator = new ScriptedEstimator([mkModelEstimate({ calories: 800, protein_g: 40 })]);
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), estimator, log);

    const ingested = await pipeline.ingest({ ulid: generateUlid(), note: 'plate' }, []);
    await ingested.estimation;

    await pipeline.patch(ingested.record.ulid, { portion_multiplier: 0.5 });
    const half = await pipeline.get(ingested.record.ulid);
    expect(half!.portion_multiplier).toBe(0.5);
    expect(half!.calories).toBe(800); // base preserved

    const updated = await pipeline.patch(ingested.record.ulid, { portion_multiplier: 0.75 });
    expect(updated!.portion_multiplier).toBe(0.75); // rescales from base, not compounding
    expect(updated!.calories).toBe(800); // base STILL untouched
    expect(updated!.calories! * updated!.portion_multiplier).toBe(600); // 0.75 × base
    // Proof it never compounded: 0.375 × 800 = 300 would be the bug.
    expect(updated!.calories! * updated!.portion_multiplier).not.toBe(300);
  });

  it('is accepted on a manual entry without a 409 and never flips source away from manual', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);

    const { record } = await pipeline.ingest({ ulid: generateUlid(), note: 'mystery bowl' }, []);
    await pipeline.patch(record.ulid, { calories: 600, protein_g: 30 });
    expect((await pipeline.get(record.ulid))!.source).toBe('manual');

    const updated = await pipeline.patch(record.ulid, { portion_multiplier: 0.25 });
    expect(updated!.portion_multiplier).toBe(0.25);
    expect(updated!.source).toBe('manual'); // orthogonal — override set base, multiplier scales it
    expect(updated!.calories).toBe(600); // base unchanged
    expect(updated!.calories! * updated!.portion_multiplier).toBe(150);
  });

  it('rides alongside a macro override in one PATCH — override sets base, multiplier scales', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);

    const { record } = await pipeline.ingest({ ulid: generateUlid(), note: 'bowl' }, []);
    const updated = await pipeline.patch(record.ulid, { calories: 400, portion_multiplier: 1.5 });
    expect(updated!.source).toBe('manual');
    expect(updated!.calories).toBe(400); // base from the override
    expect(updated!.portion_multiplier).toBe(1.5);
    expect(updated!.calories! * updated!.portion_multiplier).toBe(600);
  });

  it('is allowed on an unresolved (estimating) entry without resolving it', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);

    const { record } = await pipeline.ingest({ ulid: generateUlid(), note: 'pending' }, []);
    expect(record.status).toBe('estimating');

    const updated = await pipeline.patch(record.ulid, { portion_multiplier: 2 });
    expect(updated!.portion_multiplier).toBe(2);
    expect(updated!.status).toBe('estimating'); // multiplier doesn't resolve the entry
    expect(updated!.source).toBeNull();
  });

  it('rejects non-positive or absurd multipliers with a validation error', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);
    const { record } = await pipeline.ingest({ ulid: generateUlid(), note: 'x' }, []);

    for (const bad of [0, -1, PORTION_MULTIPLIER_MAX + 0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(pipeline.patch(record.ulid, { portion_multiplier: bad })).rejects.toThrow(PatchValidationError);
    }
    // The rejected PATCHes left the entry's multiplier at its default.
    expect((await pipeline.get(record.ulid))!.portion_multiplier).toBe(1);
  });

  it('a note edit on a manual entry still 409s even when a valid multiplier rides along (no partial write)', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);

    const { record } = await pipeline.ingest({ ulid: generateUlid(), note: 'mystery' }, []);
    await pipeline.patch(record.ulid, { calories: 500 }); // → manual

    await expect(
      pipeline.patch(record.ulid, { note: 'reopen', portion_multiplier: 0.5 })
    ).rejects.toThrow(ManualOverrideConflictError);
    // The multiplier must NOT have been applied (conflict checked before any write).
    expect((await pipeline.get(record.ulid))!.portion_multiplier).toBe(1);
  });
});

describe('logged_at backdating — post-hoc, deterministic, orthogonal', () => {
  const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  it('backdates a model entry without re-queue, source, or macro change', async () => {
    const entries = new MemoryEntryStore();
    const estimator = new ScriptedEstimator([mkModelEstimate({ calories: 500 })]);
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), estimator, log);

    const ingested = await pipeline.ingest({ ulid: generateUlid(), note: 'leftover pasta' }, []);
    await ingested.estimation;
    const backdated = iso(-3 * HOUR);

    const updated = await pipeline.patch(ingested.record.ulid, { logged_at: backdated });
    expect(updated!.logged_at.toISOString()).toBe(backdated);
    expect(updated!.source).toBe('model'); // not flipped to manual
    expect(updated!.status).toBe('estimated'); // not re-queued
    expect(updated!.calories).toBe(500); // base untouched
    expect(estimator.calls).toBe(1); // the model was NOT re-run
  });

  it('is accepted on a manual entry without a 409 and keeps source manual', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);
    const { record } = await pipeline.ingest({ ulid: generateUlid(), note: 'mystery bowl' }, []);
    await pipeline.patch(record.ulid, { calories: 600 }); // → manual

    const updated = await pipeline.patch(record.ulid, { logged_at: iso(-2 * DAY) });
    expect(updated!.source).toBe('manual');
    expect(updated!.calories).toBe(600);
  });

  it('moves the entry to the new day in a since-windowed rollup query', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);
    // Log "now"; then backdate 3 days. A window opened 1 day ago must lose it.
    const { record } = await pipeline.ingest({ ulid: generateUlid(), logged_at: iso(0), note: 'x' }, []);
    const oneDayAgo = new Date(Date.now() - DAY);
    expect((await pipeline.list({ since: oneDayAgo })).some((e) => e.ulid === record.ulid)).toBe(true);

    await pipeline.patch(record.ulid, { logged_at: iso(-3 * DAY) });
    // Same window no longer contains it — its rollup day moved with logged_at.
    expect((await pipeline.list({ since: oneDayAgo })).some((e) => e.ulid === record.ulid)).toBe(false);
    const threeDaysAgo = new Date(Date.now() - 3 * DAY - HOUR);
    expect((await pipeline.list({ since: threeDaysAgo })).some((e) => e.ulid === record.ulid)).toBe(true);
  });

  it('coerces a bare-date logged_at PATCH to local noon on the intended day (not midnight UTC)', async () => {
    // Server-side backstop for the same rule the CLI enforces (specs/modules/
    // kitchen.md § Logged-at backdating — "Bare-date coercion → local noon"):
    // a bare YYYY-MM-DD arriving on PATCH must land at local noon, so it buckets
    // on the intended day rather than the previous evening (midnight UTC). This
    // assertion is zone-independent — "local noon, that calendar day" holds in
    // any runner timezone.
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);
    const { record } = await pipeline.ingest({ ulid: generateUlid(), logged_at: iso(0), note: 'x' }, []);

    const twoDaysAgo = new Date(Date.now() - 2 * DAY);
    const y = twoDaysAgo.getFullYear();
    const m = String(twoDaysAgo.getMonth() + 1).padStart(2, '0');
    const d = String(twoDaysAgo.getDate()).padStart(2, '0');
    const bare = `${y}-${m}-${d}`;

    const updated = await pipeline.patch(record.ulid, { logged_at: bare });
    expect(updated!.logged_at.getHours()).toBe(12); // local noon, never 00:00 UTC
    expect(updated!.logged_at.getFullYear()).toBe(twoDaysAgo.getFullYear());
    expect(updated!.logged_at.getMonth()).toBe(twoDaysAgo.getMonth());
    expect(updated!.logged_at.getDate()).toBe(twoDaysAgo.getDate()); // intended day
  });

  it('composes with a portion_multiplier in one PATCH (both orthogonal axes land)', async () => {
    const entries = new MemoryEntryStore();
    const estimator = new ScriptedEstimator([mkModelEstimate({ calories: 800 })]);
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), estimator, log);
    const ingested = await pipeline.ingest({ ulid: generateUlid(), note: 'plate' }, []);
    await ingested.estimation;

    const at = iso(-5 * HOUR);
    const updated = await pipeline.patch(ingested.record.ulid, { logged_at: at, portion_multiplier: 0.5 });
    expect(updated!.logged_at.toISOString()).toBe(at);
    expect(updated!.portion_multiplier).toBe(0.5);
    expect(updated!.calories).toBe(800); // base unscaled on the wire
    expect(updated!.source).toBe('model');
  });

  it('rejects a future-beyond-skew, absurdly-old, or unparseable logged_at (no write)', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);
    const { record } = await pipeline.ingest({ ulid: generateUlid(), logged_at: iso(0), note: 'x' }, []);
    const original = (await pipeline.get(record.ulid))!.logged_at.toISOString();

    for (const bad of [iso(2 * DAY), iso(-6 * 365 * DAY), 'not-a-date']) {
      await expect(pipeline.patch(record.ulid, { logged_at: bad })).rejects.toThrow(PatchValidationError);
    }
    // Within-skew future (a few hours) is allowed — device clock/timezone slack.
    const nearFuture = iso(6 * HOUR);
    const ok = await pipeline.patch(record.ulid, { logged_at: nearFuture });
    expect(ok!.logged_at.toISOString()).toBe(nearFuture);
    expect(original).not.toBe(nearFuture); // sanity: value actually changed
  });

  it('a note edit on a manual entry still 409s even when a valid logged_at rides along (no partial write)', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);
    const { record } = await pipeline.ingest({ ulid: generateUlid(), logged_at: iso(0), note: 'mystery' }, []);
    await pipeline.patch(record.ulid, { calories: 500 }); // → manual
    const before = (await pipeline.get(record.ulid))!.logged_at.toISOString();

    await expect(
      pipeline.patch(record.ulid, { note: 'reopen', logged_at: iso(-DAY) })
    ).rejects.toThrow(ManualOverrideConflictError);
    // logged_at must NOT have been applied (conflict checked before any write).
    expect((await pipeline.get(record.ulid))!.logged_at.toISOString()).toBe(before);
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

describe('reselect_of clone — deterministic recent re-log (no model call)', () => {
  const SOURCE_NUTRITION: NutritionFields = {
    calories: 300,
    protein_g: 20,
    fat_g: 8,
    sat_fat_g: 3,
    carbs_g: 30,
    sugar_g: 9,
    fiber_g: 5,
    sodium_mg: 120,
    confidence: 0.6,
    portion_basis: 'one bowl',
  };

  /** Seed an estimated source entry directly (no estimator involved). */
  async function seedSource(
    entries: MemoryEntryStore,
    label: string,
    nutrition: NutritionFields = SOURCE_NUTRITION,
    source: 'model' | 'reselect' | 'manual' = 'model'
  ): Promise<string> {
    const ulid = generateUlid();
    await entries.insertIfAbsent({
      ulid,
      logged_at: new Date(),
      note: null,
      recipe_ulid: null,
      component_quantities: null,
    });
    await entries.applyEstimate(ulid, label, nutrition, source, 'estimated');
    return ulid;
  }

  it('clones the source entry exact base macros → instant estimated/reselect, estimator never invoked', async () => {
    const entries = new MemoryEntryStore();
    const sourceUlid = await seedSource(entries, 'Yogurt bowl');
    // A RefusingEstimator throws if the model is ever called — the assertion
    // that no estimation happens is that this ingest does NOT reject.
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), new RefusingEstimator(), log);

    const cloneUlid = generateUlid();
    const { record, created } = await pipeline.ingest({ ulid: cloneUlid, reselect_of: sourceUlid }, []);

    expect(created).toBe(true);
    expect(record.status).toBe('estimated');
    expect(record.source).toBe('reselect');
    expect(record.label).toBe('Yogurt bowl');
    expect(record.calories).toBe(300);
    expect(record.protein_g).toBe(20);
    expect(record.fat_g).toBe(8);
    expect(record.sat_fat_g).toBe(3);
    expect(record.carbs_g).toBe(30);
    expect(record.sodium_mg).toBe(120);
    expect(record.confidence).toBe(0.6);
    expect(record.portion_basis).toBe('one bowl');
    // A distinct, independent entry — not the source.
    expect(record.ulid).toBe(cloneUlid);
    expect(record.ulid).not.toBe(sourceUlid);
  });

  it('does NOT clone the portion multiplier — the clone is a fresh serving (defaults 1)', async () => {
    const entries = new MemoryEntryStore();
    const sourceUlid = await seedSource(entries, 'Yogurt bowl');
    await entries.applyPortionMultiplier(sourceUlid, 2); // source: "I ate a double"
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), new RefusingEstimator(), log);

    const { record } = await pipeline.ingest({ ulid: generateUlid(), reselect_of: sourceUlid }, []);
    expect(record.portion_multiplier).toBe(1);
    // The base macros still clone verbatim (the multiplier is orthogonal).
    expect(record.calories).toBe(300);
  });

  it('stores a note riding the clone POST as a comment and NEVER invokes the estimator', async () => {
    const entries = new MemoryEntryStore();
    const sourceUlid = await seedSource(entries, 'Yogurt bowl');
    const estimator = new RefusingEstimator();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), estimator, log);

    const { record } = await pipeline.ingest(
      { ulid: generateUlid(), reselect_of: sourceUlid, note: 'less granola today' },
      []
    );
    await pipeline.settle();

    expect(record.note).toBe('less granola today');
    expect(record.status).toBe('estimated');
    expect(record.source).toBe('reselect');
    expect(record.label).toBe('Yogurt bowl'); // the note annotates, never re-estimates
    expect(estimator.called).toBe(false);
    // Persisted, not just on the returned record.
    const stored = await pipeline.get(record.ulid);
    expect(stored!.note).toBe('less granola today');
  });

  it('is legal to clone from a manual source — the numbers are the numbers', async () => {
    const entries = new MemoryEntryStore();
    const manualNutrition: NutritionFields = { ...SOURCE_NUTRITION, calories: 512, confidence: null };
    const sourceUlid = await seedSource(entries, 'Scale-weighed dinner', manualNutrition, 'manual');
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), new RefusingEstimator(), log);

    const { record } = await pipeline.ingest({ ulid: generateUlid(), reselect_of: sourceUlid }, []);
    expect(record.source).toBe('reselect'); // the CLONE's source, not the source's
    expect(record.calories).toBe(512);
    expect(record.confidence).toBeNull();
  });

  it('rejects an unknown/deleted source ULID', async () => {
    const pipeline = new KitchenPipeline(new MemoryEntryStore(), new MemoryRecipeStore(), null, log);
    await expect(
      pipeline.ingest({ ulid: generateUlid(), reselect_of: generateUlid() }, [])
    ).rejects.toThrow(SourceEntryNotFoundError);
  });

  it('rejects a POST carrying both recipe_ulid and reselect_of', async () => {
    const pipeline = new KitchenPipeline(new MemoryEntryStore(), new MemoryRecipeStore(), null, log);
    await expect(
      pipeline.ingest(
        { ulid: generateUlid(), recipe_ulid: generateUlid(), reselect_of: generateUlid() },
        []
      )
    ).rejects.toThrow(ConflictingSourceError);
  });

  it('is idempotent on ULID: replaying a clone POST does not re-clone or regress', async () => {
    const entries = new MemoryEntryStore();
    const sourceUlid = await seedSource(entries, 'Yogurt bowl');
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), new RefusingEstimator(), log);

    const cloneUlid = generateUlid();
    const first = await pipeline.ingest({ ulid: cloneUlid, reselect_of: sourceUlid }, []);
    expect(first.created).toBe(true);
    const replay = await pipeline.ingest({ ulid: cloneUlid, reselect_of: sourceUlid }, []);
    expect(replay.created).toBe(false);
    expect(replay.record.calories).toBe(300);
    expect(replay.record.source).toBe('reselect');
  });

  it('surfaces entry_ulid on each recent summary — the source a recent pill clones', async () => {
    const entries = new MemoryEntryStore();
    const sourceUlid = await seedSource(entries, 'Yogurt bowl');
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);

    const strip = await pipeline.reselect();
    const recent = strip.recent.find((r) => r.label === 'Yogurt bowl');
    expect(recent).toBeDefined();
    expect(recent!.entry_ulid).toBe(sourceUlid);
    expect(recent!.calories).toBe(300);
  });

  it('entry_ulid tracks the MOST-RECENT occurrence of a repeated label', async () => {
    const entries = new MemoryEntryStore();
    // Two entries share a label; the newer one's ULID must be the clone source.
    const older = generateUlid();
    await entries.insertIfAbsent({ ulid: older, logged_at: new Date(Date.now() - 60_000), note: null, recipe_ulid: null, component_quantities: null });
    await entries.applyEstimate(older, 'Latte', { ...SOURCE_NUTRITION, calories: 100 }, 'model', 'estimated');
    const newer = generateUlid();
    await entries.insertIfAbsent({ ulid: newer, logged_at: new Date(), note: null, recipe_ulid: null, component_quantities: null });
    await entries.applyEstimate(newer, 'Latte', { ...SOURCE_NUTRITION, calories: 130 }, 'model', 'estimated');

    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, log);
    const strip = await pipeline.reselect();
    const recent = strip.recent.find((r) => r.label === 'Latte');
    expect(recent!.entry_ulid).toBe(newer);
    expect(recent!.calories).toBe(130); // macros come from the same most-recent row
  });
});

describe('directly-stated panel — born-manual, terminal, no estimation enqueued', () => {
  const FULL_PANEL = {
    calories: 620,
    protein_g: 41,
    fat_g: 22,
    sat_fat_g: 7,
    carbs_g: 58,
    sugar_g: 12,
    fiber_g: 9,
    sodium_mg: 880,
  };

  it('stores the panel verbatim as the base; born manual/estimated; estimator never invoked', async () => {
    const entries = new MemoryEntryStore();
    // RefusingEstimator throws if the model is ever reached — proving no
    // estimation is dispatched is exactly that this ingest never rejects and
    // never marks the estimator called.
    const estimator = new RefusingEstimator();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), estimator, log);

    const ulid = generateUlid();
    const { record, created, estimation } = await pipeline.ingest(
      { ulid, macros: { ...FULL_PANEL }, label: 'test bowl' },
      []
    );
    await pipeline.settle();

    expect(created).toBe(true);
    expect(estimation).toBeUndefined(); // nothing was enqueued to await
    expect(estimator.called).toBe(false);
    expect(record.status).toBe('estimated'); // terminal from birth
    expect(record.source).toBe('manual');
    expect(record.label).toBe('test bowl');
    // Verbatim base macros.
    expect(record.calories).toBe(620);
    expect(record.protein_g).toBe(41);
    expect(record.fat_g).toBe(22);
    expect(record.sat_fat_g).toBe(7);
    expect(record.carbs_g).toBe(58);
    expect(record.sugar_g).toBe(12);
    expect(record.fiber_g).toBe(9);
    expect(record.sodium_mg).toBe(880);
    // A stated panel is exact — nothing to be confident about, no estimate basis.
    expect(record.confidence).toBeNull();
    expect(record.portion_basis).toBeNull();
    expect(record.portion_multiplier).toBe(1);
  });

  it('the born-manual row never enters the estimation work queue', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), new RefusingEstimator(), log);

    await pipeline.ingest({ ulid: generateUlid(), macros: { ...FULL_PANEL } }, []);

    // selectForEstimation is the queue the sweep drains; a born-manual entry
    // must never appear in it (it is `estimated`, not `estimating`).
    const queued = await entries.selectForEstimation(50, KitchenPipeline.MAX_ATTEMPTS);
    expect(queued).toHaveLength(0);
  });

  it('unstated panel fields persist as null, never 0', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), new RefusingEstimator(), log);

    const ulid = generateUlid();
    // Only two of the eight fields are stated.
    const { record } = await pipeline.ingest(
      { ulid, macros: { calories: 200, protein_g: 15 } },
      []
    );

    expect(record.calories).toBe(200);
    expect(record.protein_g).toBe(15);
    expect(record.fat_g).toBeNull();
    expect(record.sat_fat_g).toBeNull();
    expect(record.carbs_g).toBeNull();
    expect(record.sugar_g).toBeNull();
    expect(record.fiber_g).toBeNull();
    expect(record.sodium_mg).toBeNull();
    // Explicitly NOT zero.
    expect(record.fat_g).not.toBe(0);
    expect(record.sodium_mg).not.toBe(0);
  });

  it('rejects a macros panel combined with recipe_ulid, reselect_of, component quantities, or photos', async () => {
    const pipeline = new KitchenPipeline(new MemoryEntryStore(), new MemoryRecipeStore(), null, log);

    await expect(
      pipeline.ingest({ ulid: generateUlid(), macros: { calories: 1 }, recipe_ulid: generateUlid() }, [])
    ).rejects.toThrow(ConflictingSourceError);
    await expect(
      pipeline.ingest({ ulid: generateUlid(), macros: { calories: 1 }, reselect_of: generateUlid() }, [])
    ).rejects.toThrow(ConflictingSourceError);
    await expect(
      pipeline.ingest(
        { ulid: generateUlid(), macros: { calories: 1 }, component_quantities: [{ label: 'rice', quantity_g: 100 }] },
        []
      )
    ).rejects.toThrow(ConflictingSourceError);
    await expect(
      pipeline.ingest({ ulid: generateUlid(), macros: { calories: 1 } }, [
        { data: Buffer.from('x'), mimeType: 'image/jpeg' },
      ])
    ).rejects.toThrow(ConflictingSourceError);
  });

  it('is idempotent on ULID: replaying a born-manual POST neither duplicates nor re-writes', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), new RefusingEstimator(), log);

    const ulid = generateUlid();
    const first = await pipeline.ingest({ ulid, macros: { ...FULL_PANEL }, label: 'test bowl' }, []);
    expect(first.created).toBe(true);

    // A replay carrying DIFFERENT numbers must not overwrite — first write wins.
    const replay = await pipeline.ingest({ ulid, macros: { calories: 1, protein_g: 1 }, label: 'other' }, []);
    expect(replay.created).toBe(false);
    expect(replay.record.calories).toBe(620); // unchanged
    expect(replay.record.protein_g).toBe(41);
    expect(replay.record.label).toBe('test bowl');
    expect(replay.record.source).toBe('manual');
    // Exactly one row exists.
    expect(entries.records.size).toBe(1);
  });

  it('a later note/label PATCH does NOT re-queue estimation (manual is terminal)', async () => {
    const entries = new MemoryEntryStore();
    const estimator = new RefusingEstimator();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), estimator, log);

    const ulid = generateUlid();
    await pipeline.ingest({ ulid, macros: { ...FULL_PANEL }, label: 'test bowl' }, []);

    // A note/label edit on a manual entry is refused (would re-open the door to
    // a model overwrite) — the same guard PATCH enforces everywhere.
    await expect(pipeline.patch(ulid, { note: 'weighed on the scale' })).rejects.toThrow(
      ManualOverrideConflictError
    );
    const after = await pipeline.get(ulid);
    expect(after!.status).toBe('estimated');
    expect(after!.source).toBe('manual');
    expect(estimator.called).toBe(false);
  });

  it('portion_multiplier scales the stated base without re-queue or source change', async () => {
    const entries = new MemoryEntryStore();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), new RefusingEstimator(), log);

    const ulid = generateUlid();
    await pipeline.ingest({ ulid, macros: { ...FULL_PANEL } }, []);
    const updated = await pipeline.patch(ulid, { portion_multiplier: 0.5 });

    expect(updated!.portion_multiplier).toBe(0.5);
    // The BASE is unchanged on the wire — every consumer computes effective.
    expect(updated!.calories).toBe(620);
    expect(updated!.status).toBe('estimated');
    expect(updated!.source).toBe('manual');
  });

  it('regression: no window in which a model estimate can overwrite the stated panel', async () => {
    // A client computes the panel and posts it directly. Unlike log→estimate→
    // patch, no original estimate is ever dispatched, so there is nothing that
    // could land late and clobber the numbers. Settling all in-flight work and
    // sweeping leaves the stated totals exactly intact.
    const entries = new MemoryEntryStore();
    const estimator = new RefusingEstimator();
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), estimator, log);

    const ulid = generateUlid();
    await pipeline.ingest({ ulid, macros: { ...FULL_PANEL } }, []);
    await pipeline.settle();
    await pipeline.sweep(); // the queue drain — must find nothing to do here

    const after = await pipeline.get(ulid);
    expect(estimator.called).toBe(false);
    expect(after!.calories).toBe(620);
    expect(after!.source).toBe('manual');
    expect(after!.status).toBe('estimated');
  });
});
