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
  ): Promise<{ record: EntryRecord; created: boolean; estimation?: Promise<boolean> }> {
    const newEntry = normalizeNewEntry(input);

    if (input.recipe_ulid) {
      // Sheet-sourced recipes are read-through projections (deterministic
      // seeded ULIDs, no DB row) — resolve DB first, then the sheet.
      const recipe =
        (await this.recipes.get(input.recipe_ulid)) ??
        (await this.readSheetRecipes()).find((r) => r.ulid === input.recipe_ulid) ??
        null;
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
    let estimation: Promise<boolean> | undefined;
    if (created || (record.status === 'estimating' && record.source !== 'manual')) {
      // Spec: the entry posts immediately and is never blocked on a model
      // call. Photos exist only in this request's memory (never persisted),
      // so estimation must START here — but the response doesn't wait for
      // it. attemptEstimate handles its own failures; callers may await the
      // returned promise (tests) or detach it (routes).
      estimation = this.attemptEstimate(record.ulid, record.note, photos);
      this.detach(estimation);
    }
    return { record: (await this.entries.get(record.ulid))!, created, estimation };
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

    // A correction is an explicit human action — estimation starts
    // immediately rather than waiting for the next sweep, but the response
    // doesn't block on the model call (same contract as ingest). No photos
    // are available on a PATCH (JSON body, not multipart).
    const requeued = await this.entries.get(ulid);
    this.detach(this.attemptEstimate(ulid, requeued!.note, []));
    return this.entries.get(ulid);
  }

  /** Detach a floating estimation; only programming errors can reject. */
  private detach(p: Promise<boolean>): void {
    this.inflight.add(p);
    void p
      .catch((error) => this.log.error({ error }, 'Detached kitchen estimation rejected'))
      .finally(() => this.inflight.delete(p));
  }

  private readonly inflight = new Set<Promise<boolean>>();

  /** Await all in-flight detached estimations (tests, graceful shutdown). */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
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
    // When the entry was itself logged from a component-bearing recipe,
    // reconstruct the REAL component list (labels + per-100g bases from the
    // source recipe, the logged quantities as the new defaults) so the
    // promoted recipe stays quantity-adjustable on future re-logs. When
    // that can't be done truthfully (see reconstructComponents), fall back
    // to a single synthetic component whose per-100g reference is the
    // entry's own resolved macros (the entry's portion is treated as the
    // 100g reference — a ballpark, per the module's "ballpark now beats
    // precision later" principle).
    const components = (await this.reconstructComponents(entry)) ?? [
      {
        label: name,
        default_qty_g: 100,
        per_100g: {
          calories: entry.calories ?? 0,
          protein_g: entry.protein_g ?? 0,
          sat_fat_g: entry.sat_fat_g ?? 0,
        },
      },
    ];
    return this.recipes.insert({
      ulid: generateUlid(),
      name,
      components,
      source: 'promoted',
    });
  }

  /**
   * Rebuild the source recipe's real component list for a promoted entry.
   * Mirrors computeRecipeMacros's join semantics: every source component
   * contributed to the entry's macros — at the logged quantity when one was
   * recorded, at the source default otherwise — so every source component
   * is carried, with the logged quantity_g becoming the new default_qty_g.
   *
   * Returns null (caller falls back to the synthetic-total component) when
   * reconstruction wouldn't be truthful to the entry's resolved macros:
   * - the entry wasn't recipe-computed (`source` !== 'reselect' — notably a
   *   manual override is terminal, and the source recipe's components no
   *   longer describe the corrected totals), or carries no recipe_ulid /
   *   component_quantities;
   * - the source recipe is gone (deleted DB row, or a sheet recipe that no
   *   longer resolves) or has no components;
   * - a logged quantity's label matches no source component. We can't
   *   distinguish a stray quantity (which contributed nothing at ingest —
   *   skipping it would be harmless) from source-recipe drift (the
   *   component was renamed/removed after ingest, so it DID contribute —
   *   skipping it would silently understate the meal). Under drift the
   *   surviving labels' bases may be stale too, so the whole
   *   reconstruction is abandoned: the synthetic-total fallback equals the
   *   entry's resolved macros by construction, which is the truthful floor.
   */
  private async reconstructComponents(entry: EntryRecord): Promise<RecipeComponent[] | null> {
    const quantities = entry.component_quantities;
    if (entry.source !== 'reselect' || !entry.recipe_ulid || !quantities || quantities.length === 0) {
      return null;
    }

    // Same resolution order as ingest: DB row first, then the read-through
    // sheet projection.
    const recipe =
      (await this.recipes.get(entry.recipe_ulid)) ??
      (await this.readSheetRecipes()).find((r) => r.ulid === entry.recipe_ulid) ??
      null;
    if (!recipe || recipe.components.length === 0) return null;

    const sourceLabels = new Set(recipe.components.map((c) => c.label));
    if (quantities.some((q) => !sourceLabels.has(q.label))) return null;

    const qtyByLabel = new Map(quantities.map((q) => [q.label, q.quantity_g]));
    return recipe.components.map((component) => ({
      label: component.label,
      default_qty_g: qtyByLabel.get(component.label) ?? component.default_qty_g,
      per_100g: { ...component.per_100g },
    }));
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
