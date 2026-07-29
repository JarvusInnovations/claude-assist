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
import {
  LOGGED_AT_FUTURE_SKEW_MS,
  LOGGED_AT_MAX_AGE_MS,
  normalizeRecipeName,
  NUTRITION_FIELD_KEYS,
  PORTION_MULTIPLIER_MAX,
} from '../types.js';
import type { EntryStore, RecipeStore, RecentEntrySummary } from '../store.js';
import { normalizeNewEntry } from '../store.js';
import { coerceBareDateToLocalNoon } from '../date-coerce.js';
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

/**
 * A `POST /recipes` upsert whose name resolves to something it must not clobber
 * (specs/modules/kitchen.md § Recipe corrections). Mapped to `409` at the route.
 *
 * Refusing beats guessing here: a promoted recipe is the record of a meal the
 * owner actually logged and a sheet recipe belongs to the meal-bank sheet this
 * module never writes, so neither may be silently overwritten by a name
 * collision on a push — and when several pushed forks already share a name,
 * nothing in the request says which one is canonical. The message names every
 * candidate and both ways forward.
 */
export class RecipeNameConflictError extends Error {
  constructor(
    readonly name_: string,
    readonly candidates: Array<{ ulid: string; source: string }>,
    /**
     * How the caller gets unstuck. Differs by entry point: a push can name an
     * explicit `ulid` to replace a specific record, but promote derives its
     * macros from one particular entry — replacing a recipe built from a
     * DIFFERENT entry would silently rewrite it, so promote's only remedy is a
     * distinct name.
     */
    remedy = 'Rename this recipe, or pass an explicit ulid to replace a specific record.'
  ) {
    const listed = candidates.map((c) => `${c.ulid} (${c.source})`).join(', ');
    super(`Recipe name "${name_}" already belongs to ${listed}. ${remedy}`);
    this.name = 'RecipeNameConflictError';
  }
}

/**
 * A `reselect_of` POST referenced a source entry that does not exist (unknown
 * ULID, or an entry deleted since the reselect strip was built). Mapped to 400
 * at the route — never a silently-empty clone (specs/modules/kitchen.md
 * § Reselect cloning).
 */
export class SourceEntryNotFoundError extends Error {
  constructor(sourceUlid: string) {
    super(`reselect_of references an unknown source entry: ${sourceUlid}`);
    this.name = 'SourceEntryNotFoundError';
  }
}

/**
 * A POST combined more than one creation shape — `recipe_ulid`, `reselect_of`,
 * `macros`, component quantities, and photos are mutually exclusive (400).
 */
export class ConflictingSourceError extends Error {
  constructor(message = 'recipe_ulid and reselect_of are mutually exclusive on one entry') {
    super(message);
    this.name = 'ConflictingSourceError';
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
  /**
   * Phase-2 depletion hook: called (detached) with an entry once it reaches
   * terminal `estimated`, so the inventory module can plausibly match + deplete
   * an on-hand item. Injected by the module — the entry pipeline stays
   * inventory-agnostic. Its failures never affect the entry.
   */
  onEntryEstimated?: (entry: EntryRecord) => Promise<void>;
}

export class KitchenPipeline {
  /** Mirrors capture's attempt cap — a row that fails this many times stops being swept. */
  static readonly MAX_ATTEMPTS = 5;

  private limit: ReturnType<typeof pLimit>;
  private batchSize: number;
  private readSheetRecipes: () => Promise<RecipeRecord[]>;
  private onEntryEstimated?: (entry: EntryRecord) => Promise<void>;
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
    this.onEntryEstimated = config.onEntryEstimated;
  }

  /** Endpoint-side: idempotent ingest. Photos are used for one attempt, then dropped. */
  async ingest(
    input: EntryInput,
    photos: PhotoPart[]
  ): Promise<{ record: EntryRecord; created: boolean; estimation?: Promise<boolean> }> {
    const newEntry = normalizeNewEntry(input);

    // recipe_ulid and reselect_of are mutually exclusive — a POST is one kind
    // of deterministic re-log or the other, never both.
    if (input.recipe_ulid && input.reselect_of) {
      throw new ConflictingSourceError();
    }

    if (input.macros) {
      // Directly-stated panel (specs/modules/kitchen.md § Directly-stated panel
      // entries): the caller already computed the eight-field panel, so it is
      // stored verbatim as the base of a born-`manual`, terminal entry. This
      // branch enqueues NO estimation — that is the load-bearing invariant. It
      // eliminates the log→estimate→patch birth-race: there is no original
      // estimate that could land after and clobber the stated numbers, because
      // none is ever dispatched. Mutually exclusive with every other shape.
      if (
        input.recipe_ulid ||
        input.reselect_of ||
        (input.component_quantities && input.component_quantities.length > 0) ||
        photos.length > 0
      ) {
        throw new ConflictingSourceError(
          'macros is mutually exclusive with recipe_ulid, reselect_of, component quantities, and photos'
        );
      }

      const { record, created } = await this.entries.insertIfAbsent(newEntry);
      if (created) {
        // Store the panel exactly as stated — an unstated field is `null`
        // (unknown), never `0`. confidence is null (there is nothing to be
        // confident about; the numbers are exact), portion_basis null.
        const nutrition: NutritionFields = {
          calories: input.macros.calories ?? null,
          protein_g: input.macros.protein_g ?? null,
          fat_g: input.macros.fat_g ?? null,
          sat_fat_g: input.macros.sat_fat_g ?? null,
          carbs_g: input.macros.carbs_g ?? null,
          sugar_g: input.macros.sugar_g ?? null,
          added_sugar_g: input.macros.added_sugar_g ?? null,
          fiber_g: input.macros.fiber_g ?? null,
          sodium_mg: input.macros.sodium_mg ?? null,
          confidence: null,
          portion_basis: null,
        };
        // Sibling of the recipe/reselect deterministic writes: one atomic
        // applyEstimate lands the terminal `estimated` state, here with
        // source `manual`. No attemptEstimate call, so nothing enters the
        // `estimating` work queue.
        const nextStatus = transition('estimating', { kind: 'estimated' });
        await this.entries.applyEstimate(record.ulid, input.label ?? null, nutrition, 'manual', nextStatus);
        this.notifyEstimated(record.ulid);
      }
      // Replay (created === false) is a safe no-op: the existing row is returned
      // untouched — no duplicate, no re-write.
      return { record: (await this.entries.get(record.ulid))!, created };
    }

    if (input.reselect_of) {
      // Recent-pill re-log: deterministically CLONE the source entry's label +
      // base macros. No model call — the numbers already exist on the source
      // (specs/modules/kitchen.md § Reselect cloning). A note on this POST is
      // stored as a comment (via normalizeNewEntry → insertIfAbsent) and does
      // NOT trigger estimation.
      const source = await this.entries.get(input.reselect_of);
      if (!source) throw new SourceEntryNotFoundError(input.reselect_of);

      const { record, created } = await this.entries.insertIfAbsent(newEntry);
      if (created) {
        // Copy the source's base macro fields + the confidence/portion_basis
        // that describe them. portion_multiplier is deliberately NOT cloned —
        // the clone is a fresh serving and defaults to 1.
        const nutrition: NutritionFields = {
          calories: source.calories,
          protein_g: source.protein_g,
          fat_g: source.fat_g,
          sat_fat_g: source.sat_fat_g,
          carbs_g: source.carbs_g,
          sugar_g: source.sugar_g,
          added_sugar_g: source.added_sugar_g,
          fiber_g: source.fiber_g,
          sodium_mg: source.sodium_mg,
          confidence: source.confidence,
          portion_basis: source.portion_basis,
        };
        const nextStatus = transition('estimating', { kind: 'estimated' });
        await this.entries.applyEstimate(record.ulid, source.label, nutrition, 'reselect', nextStatus);
        this.notifyEstimated(record.ulid);
      }
      return { record: (await this.entries.get(record.ulid))!, created };
    }

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
        this.notifyEstimated(record.ulid);
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
   * PATCH semantics (specs/modules/kitchen.md § API + § Portion multiplier):
   * three orthogonal axes.
   * - A macro override (any nutrition field present) is always accepted and is
   *   terminal (source='manual'). It sets the BASE macros.
   * - A note/label-only edit re-queues estimation, but is refused with
   *   `ManualOverrideConflictError` when the entry is already `manual` —
   *   re-queuing would open the door to a later model pass overwriting the
   *   owner's correction, which the spec forbids outright.
   * - A `portion_multiplier` is accepted on ANY entry regardless of source; it
   *   rescales the base post-hoc and touches nothing else (no source change, no
   *   re-queue). It may ride alongside a macro override (override sets base,
   *   multiplier scales it).
   * - A `logged_at` (§ Logged-at backdating) is likewise accepted on ANY entry;
   *   it backdates the entry to the meal's actual moment and touches nothing
   *   else (no source change, no re-queue). Rollups re-bucket by `logged_at` at
   *   query time, so moving it moves the entry's day everywhere.
   *
   * All validation and conflict checks happen up front, before any write, so a
   * rejected PATCH never leaves a partial change (e.g. multiplier applied but
   * the note edit 409'd).
   */
  /**
   * Parse + bounds-check a PATCHed `logged_at` (specs/modules/kitchen.md
   * § Logged-at backdating). Deterministic — the timestamp comes from the
   * client (EXIF or the owner's pick), never the model. Rejects unparseable
   * values, anything more than LOGGED_AT_FUTURE_SKEW_MS ahead of now, or more
   * than LOGGED_AT_MAX_AGE_MS behind now.
   */
  private validateLoggedAt(raw: string): Date {
    if (typeof raw !== 'string') {
      throw new PatchValidationError('logged_at must be an ISO date-time string');
    }
    // A bare `YYYY-MM-DD` coerces to local noon before parse+bounds (specs/
    // modules/kitchen.md § Logged-at backdating); a full timestamp is untouched.
    const parsed = new Date(coerceBareDateToLocalNoon(raw));
    const t = parsed.getTime();
    if (Number.isNaN(t)) {
      throw new PatchValidationError('logged_at must be a valid ISO date-time');
    }
    const now = Date.now();
    if (t > now + LOGGED_AT_FUTURE_SKEW_MS) {
      throw new PatchValidationError('logged_at is too far in the future');
    }
    if (t < now - LOGGED_AT_MAX_AGE_MS) {
      throw new PatchValidationError('logged_at is implausibly far in the past');
    }
    return parsed;
  }

  async patch(ulid: string, input: EntryPatchInput): Promise<EntryRecord | null> {
    const entry = await this.entries.get(ulid);
    if (!entry) return null;

    const hasMacroOverride = NUTRITION_FIELD_KEYS.some((key) => input[key] !== undefined);
    const hasNoteLabelEdit = input.note !== undefined || input.label !== undefined;
    const hasMultiplier = input.portion_multiplier !== undefined;
    const hasLoggedAt = input.logged_at !== undefined;

    // ── Validate everything up front (no partial writes on a rejected PATCH) ──
    if (hasMultiplier) {
      const m = input.portion_multiplier!;
      if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0 || m > PORTION_MULTIPLIER_MAX) {
        throw new PatchValidationError(
          `portion_multiplier must be a number in (0, ${PORTION_MULTIPLIER_MAX}]`
        );
      }
    }
    let loggedAt: Date | undefined;
    if (hasLoggedAt) {
      loggedAt = this.validateLoggedAt(input.logged_at!);
    }
    if (!hasMultiplier && !hasLoggedAt && !hasMacroOverride && !hasNoteLabelEdit) {
      throw new PatchValidationError(
        'PATCH body must set a note/label edit, at least one nutrition field, portion_multiplier, or logged_at'
      );
    }
    // A note/label-only edit re-queues; forbidden on a terminal manual entry.
    const willRequeue = hasNoteLabelEdit && !hasMacroOverride;
    if (willRequeue && entry.source === 'manual') {
      throw new ManualOverrideConflictError(ulid);
    }

    // ── Apply. The multiplier and logged_at are orthogonal — never re-queue,
    //    never change source — so they land first and independently. ──
    if (hasMultiplier) {
      await this.entries.applyPortionMultiplier(ulid, input.portion_multiplier!);
    }
    if (hasLoggedAt) {
      await this.entries.applyLoggedAt(ulid, loggedAt!);
    }

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

    if (willRequeue) {
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

    // Orthogonal-axis-only PATCH (multiplier and/or logged_at): the applies
    // above are all there is to do.
    return this.entries.get(ulid);
  }

  /**
   * Fire the phase-2 depletion hook (detached) for an entry that just reached
   * `estimated`. The hook's failures never touch the entry — the depletion
   * matcher is best-effort per the module's directional-inventory principle.
   */
  private notifyEstimated(ulid: string): void {
    if (!this.onEntryEstimated) return;
    const p = (async () => {
      const entry = await this.entries.get(ulid);
      if (entry) await this.onEntryEstimated!(entry);
    })();
    this.inflight.add(p);
    void p
      .catch((error) => this.log.warn({ error, ulid }, 'Depletion hook rejected'))
      .finally(() => this.inflight.delete(p));
  }

  /** Detach a floating estimation; only programming errors can reject. */
  private detach(p: Promise<boolean>): void {
    this.inflight.add(p);
    void p
      .catch((error) => this.log.error({ error }, 'Detached kitchen estimation rejected'))
      .finally(() => this.inflight.delete(p));
  }

  private readonly inflight = new Set<Promise<unknown>>();

  /** Await all in-flight detached estimations (tests, graceful shutdown). */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  /**
   * `POST /recipes` — an **upsert** (specs/modules/kitchen.md § Recipe
   * corrections), not a blind insert. Pushing a correction used to mint a
   * second row: recipes are tapped from the strip by NAME, so the two forks
   * were indistinguishable and the stale one kept logging the wrong numbers on
   * every tap. A correction has to replace.
   *
   * - `ulid` supplied → create-or-replace that exact record, idempotent on the
   *   key (the convention `POST /inventory` uses). A replace preserves `ulid`,
   *   `created_at`, and `source`; a create is `pushed`. An explicit key is
   *   explicit intent, so this is the escape hatch for every conflict below.
   * - otherwise → the **normalized name** is the key, resolved against LIVE
   *   DB recipes: no match creates, one `pushed` match is replaced in place,
   *   and anything else (`promoted`, a `sheet` name collision, or several
   *   pushed forks) throws `RecipeNameConflictError`.
   *
   * `created` distinguishes insert from replace so the route can answer
   * `201` vs `200`.
   */
  async pushRecipe(input: {
    ulid?: string;
    name: string;
    components?: RecipeComponent[];
  }): Promise<{ recipe: RecipeRecord; created: boolean }> {
    const components = input.components ?? [];

    if (input.ulid) {
      const replaced = await this.recipes.replace(input.ulid, { name: input.name, components });
      if (replaced) return { recipe: replaced, created: false };
      const recipe = await this.recipes.insert({
        ulid: input.ulid,
        name: input.name,
        components,
        source: 'pushed',
      });
      return { recipe, created: true };
    }

    const normalized = normalizeRecipeName(input.name);
    const matches = await this.recipes.findLiveByNormalizedName(normalized);
    // A sheet recipe can't be replaced (the module never writes the sheet), but
    // letting a pushed twin exist under the same name recreates the exact
    // ambiguity this upsert removes — so a collision there refuses too.
    const sheetTwins = await this.findSheetTwins(normalized);

    const blocking = [
      ...matches.filter((r) => r.source !== 'pushed'),
      ...sheetTwins,
    ];
    if (blocking.length > 0 || matches.length > 1) {
      const candidates = (blocking.length > 0 ? blocking : matches).map((r) => ({
        ulid: r.ulid,
        source: r.source as string,
      }));
      throw new RecipeNameConflictError(input.name, candidates);
    }

    const existing = matches[0];
    if (existing) {
      const replaced = await this.recipes.replace(existing.ulid, { name: input.name, components });
      // Vanished between read and write (concurrent archive/delete) — fall
      // through to a create rather than reporting a replace that didn't happen.
      if (replaced) return { recipe: replaced, created: false };
    }

    const recipe = await this.recipes.insert({
      ulid: generateUlid(),
      name: input.name,
      components,
      source: 'pushed',
    });
    return { recipe, created: true };
  }

  /**
   * `DELETE /recipes/:ulid` — **archive**, never destroy (§ Recipe
   * corrections). An archived recipe leaves the strip and every merged listing
   * but stays resolvable by ULID, so entries that reference it, promote's
   * component reconstruction, and a derived item's consume eligibility all keep
   * working. Idempotent. Null for an unknown ULID — including a sheet-sourced
   * one, which has no row here to retire.
   */
  async archiveRecipe(ulid: string): Promise<RecipeRecord | null> {
    return this.recipes.archive(ulid);
  }

  /** Sheet-sourced recipes whose name normalizes to `normalized`. */
  private async findSheetTwins(normalized: string): Promise<RecipeRecord[]> {
    return (await this.readSheetRecipes()).filter(
      (r) => normalizeRecipeName(r.name) === normalized
    );
  }

  /**
   * Every LIVE recipe already holding this name, across all sources (archived
   * rows are excluded — archiving frees the name). Used by `promote`, which
   * refuses on ANY collision rather than replacing; `pushRecipe` needs a
   * narrower rule (a single `pushed` match is replaceable) so it does its own
   * partitioning rather than calling this.
   */
  private async findLiveNameCollisions(
    name: string
  ): Promise<Array<{ ulid: string; source: string }>> {
    const normalized = normalizeRecipeName(name);
    const [matches, sheetTwins] = await Promise.all([
      this.recipes.findLiveByNormalizedName(normalized),
      this.findSheetTwins(normalized),
    ]);
    return [...matches, ...sheetTwins].map((r) => ({ ulid: r.ulid, source: r.source as string }));
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
    // Promote is an INSERT, so promoting twice under one label used to mint a
    // same-named `promoted` twin — the indistinguishable-pill problem
    // `pushRecipe`'s upsert removed, arriving through the other door. Refuse
    // rather than replace: a promoted recipe is the record of ONE entry's
    // macros, so replacing one derived from a different entry would silently
    // rewrite it (see RecipeNameConflictError's remedy note).
    //
    // Scoped to `promoted` collisions ONLY, deliberately. Promoting an entry
    // that was itself logged FROM a recipe shares that recipe's name by
    // construction, and it's an intended flow — reconstructComponents exists to
    // serve it. So a pushed/sheet twin is allowed here. That leaves a narrower
    // version of the ambiguity alive (one pushed + one promoted under one name);
    // collapsing sources under a single name is a bigger design call than this
    // fix, and it's recorded as such in the spec rather than decided here.
    const collisions = (await this.findLiveNameCollisions(name)).filter(
      (c) => c.source === 'promoted'
    );
    if (collisions.length > 0) {
      throw new RecipeNameConflictError(
        name,
        collisions,
        'Pass an explicit name to promote under, or archive the existing recipe first.'
      );
    }

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

  /**
   * The module's full merged recipe view — sheet + pushed + promoted, the same
   * merge reselect performs, without the recents strip or its small default
   * limit. Backs the decorated `fastify.kitchenRecipes` surface consumed (via
   * the server-composed provider) by stock-aware briefing suggestions.
   */
  async listAllRecipes(limit = 500): Promise<RecipeRecord[]> {
    const [sheetRecipes, dbRecipes] = await Promise.all([
      this.readSheetRecipes(),
      this.recipes.list({ limit }),
    ]);
    return [...sheetRecipes, ...dbRecipes];
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
        sugar_g: adjusted.sugar_g,
        added_sugar_g: adjusted.added_sugar_g,
        fiber_g: adjusted.fiber_g,
        sodium_mg: adjusted.sodium_mg,
        confidence: adjusted.confidence,
        portion_basis: adjusted.portion_basis,
      };
      await this.entries.applyEstimate(ulid, adjusted.label, nutrition, 'model', nextStatus);
      this.notifyEstimated(ulid);
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
