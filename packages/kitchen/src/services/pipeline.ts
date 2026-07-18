/**
 * Kitchen pipeline: entry ingest/patch/promote (endpoint-side) + the
 * estimation sweep (scheduler-side). Mirrors capture's
 * services/pipeline.ts shape, adapted for the photos-never-persisted
 * constraint (specs/modules/kitchen.md § Data Requirements):
 *
 * - A fresh non-deterministic entry attempts estimation immediately, using
 *   the in-memory photo buffers from THIS request — there is nowhere else
 *   they could be used later, since they're discarded on every outcome.
 * - A replay POST (same ULID) while the row is still `estimating` retries
 *   estimation with whatever photos this replay carries — the deliberate
 *   divergence from capture's pure ack-only idempotency, driven by the "no
 *   photo persistence" constraint (the client is the retry's source of truth).
 * - The scheduled sweep exists for rows that are stuck `estimating` with no
 *   estimator configured at ingest time (mirrors capture's "leaves queued,
 *   no classifier" case): once a key is configured, the sweep retries them
 *   from their note text alone (no photos ever survive to a sweep pass).
 */

import pLimit from 'p-limit';
import type { FastifyBaseLogger } from 'fastify';
import type {
  ComponentQuantity,
  EntryInput,
  EntryPatchInput,
  EntryRecord,
  NutritionFields,
  PhotoPart,
  RecipeComponent,
  RecipeRecord,
} from '../types.js';
import { NUTRITION_FIELD_KEYS } from '../types.js';
import type { EntryStore, RecipeStore, RecentEntrySummary } from '../store.js';
import { normalizeNewEntry } from '../store.js';
import { InvalidTransitionError, transition } from '../state.js';
import { generateUlid } from '../ulid.js';
import { computeRecipeMacros } from './recipes.js';
import type { Estimator } from './estimator.js';
import { applyPortionModifier, portionModifierFor } from './estimator.js';

export class RecipeNotFoundError extends Error {
  constructor(recipeUlid: string) {
    super(`Recipe not found: ${recipeUlid}`);
    this.name = 'RecipeNotFoundError';
  }
}

/** The owner's manual override is terminal — thrown on a note/label edit that would re-queue one. */
export class ManualOverrideConflictError extends Error {
  constructor(ulid: string) {
    super(`Entry ${ulid} carries a manual override and is terminal — cannot re-queue for estimation`);
    this.name = 'ManualOverrideConflictError';
  }
}

export class PatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchValidationError';
  }
}

export class PromoteNotReadyError extends Error {
  constructor(ulid: string) {
    super(`Entry ${ulid} has no resolved nutrition yet — cannot promote to a recipe`);
    this.name = 'PromoteNotReadyError';
  }
}

export interface SweepResult {
  estimated: number;
  failed: number;
  skipped: number;
}

export interface ReselectStrip {
  recipes: RecipeRecord[];
  recent: RecentEntrySummary[];
}

export interface KitchenPipelineConfig {
  /** Parallelism for the estimation sweep (default 3). */
  concurrency?: number;
  /** Rows selected per sweep (default 50). */
  batchSize?: number;
  /** Sheet-sourced recipe reader override (tests; default: none — empty list). */
  readSheetRecipes?: () => Promise<RecipeRecord[]>;
}

export class KitchenPipeline {
  /** Mirrors capture's attempt cap — a row that fails this many times stops being swept. */
  static readonly MAX_ATTEMPTS = 5;

  private limit: ReturnType<typeof pLimit>;
  private batchSize: number;
  private readSheetRecipes: () => Promise<RecipeRecord[]>;
  private sweeping = false;

  constructor(
    private entries: EntryStore,
    private recipes: RecipeStore,
    private estimator: Estimator | null,
    private log: FastifyBaseLogger,
    config: KitchenPipelineConfig = {}
  ) {
    this.limit = pLimit(config.concurrency ?? 3);
    this.batchSize = config.batchSize ?? 50;
    this.readSheetRecipes = config.readSheetRecipes ?? (async () => []);
  }

  /** Endpoint-side: idempotent ingest. Photos are used for one attempt, then dropped. */
  async ingest(
    input: EntryInput,
    photos: PhotoPart[]
  ): Promise<{ record: EntryRecord; created: boolean }> {
    const newEntry = normalizeNewEntry(input);

    if (input.recipe_ulid) {
      const recipe = await this.recipes.get(input.recipe_ulid);
      if (!recipe) throw new RecipeNotFoundError(input.recipe_ulid);

      const { record, created } = await this.entries.insertIfAbsent(newEntry);
      if (created) {
        const nutrition = computeRecipeMacros(recipe, input.component_quantities);
        const nextStatus = transition('estimating', { kind: 'estimated' });
        await this.entries.applyEstimate(record.ulid, recipe.name, nutrition, 'reselect', nextStatus);
      }
      return { record: (await this.entries.get(record.ulid))!, created };
    }

    const { record, created } = await this.entries.insertIfAbsent(newEntry);
    if (created || (record.status === 'estimating' && record.source !== 'manual')) {
      await this.attemptEstimate(record.ulid, record.note, photos);
    }
    return { record: (await this.entries.get(record.ulid))!, created };
  }

  async get(ulid: string): Promise<EntryRecord | null> {
    return this.entries.get(ulid);
  }

  async list(filter: { since?: Date; limit?: number }): Promise<EntryRecord[]> {
    return this.entries.list(filter);
  }

  async delete(ulid: string): Promise<boolean> {
    return this.entries.delete(ulid);
  }

  /**
   * PATCH semantics (specs/modules/kitchen.md § API): a macro override
   * (any nutrition field present) is always accepted and is terminal
   * (source='manual'). A note/label-only edit re-queues estimation, but is
   * refused with `ManualOverrideConflictError` when the entry is already
   * `manual` — re-queuing it would open the door to a later model pass
   * overwriting the owner's correction, which the spec forbids outright.
   */
  async patch(ulid: string, input: EntryPatchInput): Promise<EntryRecord | null> {
    const entry = await this.entries.get(ulid);
    if (!entry) return null;

    const hasMacroOverride = NUTRITION_FIELD_KEYS.some((key) => input[key] !== undefined);

    if (hasMacroOverride) {
      const nutrition: Partial<NutritionFields> = {};
      for (const key of NUTRITION_FIELD_KEYS) {
        const value = input[key];
        if (value !== undefined) nutrition[key] = value;
      }
      if (input.portion_basis !== undefined) nutrition.portion_basis = input.portion_basis;

      transition(entry.status, { kind: 'manual_override' });
      await this.entries.applyManualOverride(ulid, nutrition, { label: input.label, note: input.note });
      return this.entries.get(ulid);
    }

    if (input.note === undefined && input.label === undefined) {
      throw new PatchValidationError('PATCH body must set a note/label edit or at least one nutrition field');
    }

    if (entry.source === 'manual') {
      throw new ManualOverrideConflictError(ulid);
    }

    transition(entry.status, { kind: 're_queue' });
    await this.entries.applyRequeue(ulid, { label: input.label, note: input.note });

    // A correction is an explicit human action — route immediately rather
    // than waiting for the next sweep (mirrors capture's correct() path).
    // No photos are available on a PATCH (JSON body, not multipart).
    const requeued = await this.entries.get(ulid);
    await this.attemptEstimate(ulid, requeued!.note, []);
    return this.entries.get(ulid);
  }

  async pushRecipe(input: { name: string; components?: RecipeComponent[] }): Promise<RecipeRecord> {
    return this.recipes.insert({
      ulid: generateUlid(),
      name: input.name,
      components: input.components ?? [],
      source: 'pushed',
    });
  }

  /** Creates a recipe from a logged entry's resolved macros (POST /entries/:ulid/promote). */
  async promote(ulid: string, nameOverride?: string): Promise<RecipeRecord | null> {
    const entry = await this.entries.get(ulid);
    if (!entry) return null;
    if (entry.status !== 'estimated' || entry.calories === null) {
      throw new PromoteNotReadyError(ulid);
    }

    const name = nameOverride?.trim() || entry.label || entry.note || 'Promoted recipe';
    // v1 simplification: a promoted recipe is a single synthetic component
    // whose per-100g reference is the entry's own resolved macros (the
    // entry's portion is treated as the 100g reference — a ballpark, per
    // the module's "ballpark now beats precision later" principle). A
    // richer promotion (reusing the original recipe's real components when
    // the entry itself was recipe-computed) is left for a later pass — see
    // plans/kitchen-module.md.
    const component: RecipeComponent = {
      label: name,
      default_qty_g: 100,
      per_100g: {
        calories: entry.calories ?? 0,
        protein_g: entry.protein_g ?? 0,
        sat_fat_g: entry.sat_fat_g ?? 0,
      },
    };
    return this.recipes.insert({
      ulid: generateUlid(),
      name,
      components: [component],
      source: 'promoted',
    });
  }

  /** GET /reselect: recipes (sheet + pushed + promoted) merged with recent/frequent logged items. */
  async reselect(limit = 20): Promise<ReselectStrip> {
    const [sheetRecipes, dbRecipes, recent] = await Promise.all([
      this.readSheetRecipes(),
      this.recipes.list({ limit }),
      this.entries.recentLabels(limit),
    ]);
    return { recipes: [...sheetRecipes, ...dbRecipes], recent };
  }

  /** Scheduler-side sweep: retry `estimating` rows under the attempt cap (note-only — no photos survive). */
  async sweep(): Promise<SweepResult> {
    if (this.sweeping) {
      this.log.info('Kitchen estimation sweep already in progress - skipping');
      return { estimated: 0, failed: 0, skipped: 0 };
    }
    this.sweeping = true;
    try {
      const rows = await this.entries.selectForEstimation(this.batchSize, KitchenPipeline.MAX_ATTEMPTS);
      const result: SweepResult = { estimated: 0, failed: 0, skipped: 0 };

      await Promise.all(
        rows.map((row) =>
          this.limit(async () => {
            const ok = await this.attemptEstimate(row.ulid, row.note, []);
            if (ok) {
              result.estimated++;
              return;
            }
            const after = await this.entries.get(row.ulid);
            if (after?.status === 'failed') result.failed++;
            else result.skipped++;
          })
        )
      );

      return result;
    } finally {
      this.sweeping = false;
    }
  }

  private async attemptEstimate(ulid: string, note: string | null, photos: PhotoPart[]): Promise<boolean> {
    if (!this.estimator) {
      // No API key configured: leave the row estimating without burning an
      // attempt, exactly like capture's "no classifier" shortcut.
      return false;
    }
    try {
      const raw = await this.estimator.estimate({ note, photos });
      const factor = portionModifierFor(note);
      const adjusted = applyPortionModifier(raw, factor);
      const nextStatus = transition('estimating', { kind: 'estimated' });
      const nutrition: NutritionFields = {
        calories: adjusted.calories,
        protein_g: adjusted.protein_g,
        fat_g: adjusted.fat_g,
        sat_fat_g: adjusted.sat_fat_g,
        carbs_g: adjusted.carbs_g,
        sodium_mg: adjusted.sodium_mg,
        confidence: adjusted.confidence,
        portion_basis: adjusted.portion_basis,
      };
      await this.entries.applyEstimate(ulid, adjusted.label, nutrition, 'model', nextStatus);
      return true;
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const attempts = await this.entries.recordEstimationFailure(ulid, message);
      this.log.error(
        { ulid, attempts, error: message },
        attempts >= KitchenPipeline.MAX_ATTEMPTS
          ? 'Kitchen estimation failed max attempts - sweep will stop retrying'
          : 'Kitchen estimation failed'
      );
      if (attempts >= KitchenPipeline.MAX_ATTEMPTS) {
        transition('estimating', { kind: 'estimate_capped' });
        await this.entries.applyEstimateCapped(ulid);
      }
      return false;
    }
  }
}

/** Re-exported for routes/tests that need to build component quantities. */
export type { ComponentQuantity };
