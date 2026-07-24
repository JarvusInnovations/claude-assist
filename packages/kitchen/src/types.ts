/**
 * Kitchen module types.
 *
 * Phase 1 (this file): consumption entries + recipes. Phase 2 (inventory:
 * receipts, labels, lexicon, stock, events) extends this per
 * specs/modules/kitchen.md.
 */

export type EntryStatus = 'estimating' | 'estimated' | 'failed';

export const ENTRY_STATUSES: readonly EntryStatus[] = ['estimating', 'estimated', 'failed'];

/**
 * How an entry's nutrition was resolved:
 * - model: one vision/text estimation call
 * - reselect: deterministic — recipe-computed macros, or cloned from the
 *   reselect strip (a past entry or a recipe picked instead of typed fresh)
 * - manual: the owner's correction. Terminal — no later model pass may
 *   overwrite it (specs/modules/kitchen.md "the owner's correction is terminal").
 */
export type EstimationSource = 'model' | 'reselect' | 'manual';

export const ESTIMATION_SOURCES: readonly EstimationSource[] = ['model', 'reselect', 'manual'];

export type RecipeSource = 'sheet' | 'pushed' | 'promoted';

export const RECIPE_SOURCES: readonly RecipeSource[] = ['sheet', 'pushed', 'promoted'];

/** A quantity for one recipe component as actually used in a logged entry. */
export interface ComponentQuantity {
  label: string;
  quantity_g: number;
}

/**
 * Per-100g nutrition reference for one recipe ingredient — the FULL panel
 * (§ Nutrition panel), so a recipe-computed meal is nutritionally complete.
 * `calories`/`protein_g`/`sat_fat_g` remain required (the original contract
 * floor); the rest are optional for backward compatibility — a component that
 * omits a field contributes "unknown" to that field's total, not zero.
 */
export interface RecipeComponentMacros {
  calories: number;
  protein_g: number;
  sat_fat_g: number;
  fat_g?: number | null;
  carbs_g?: number | null;
  sugar_g?: number | null;
  fiber_g?: number | null;
  sodium_mg?: number | null;
}

export interface RecipeComponent {
  label: string;
  default_qty_g: number;
  per_100g: RecipeComponentMacros;
}

/** A row in kitchen.recipes (or a read-through sheet projection with the same shape). */
export interface RecipeRecord {
  ulid: string;
  name: string;
  components: RecipeComponent[];
  source: RecipeSource;
  created_at: Date;
  updated_at: Date;
}

/**
 * Flattened nutrition estimate carried on an entry — the eight-field panel
 * (§ Nutrition panel). Unknown fields are null, never 0.
 */
export interface NutritionFields {
  calories: number | null;
  protein_g: number | null;
  fat_g: number | null;
  sat_fat_g: number | null;
  carbs_g: number | null;
  sugar_g: number | null;
  fiber_g: number | null;
  sodium_mg: number | null;
  /** 0..1; null for manual overrides (there's nothing to be confident about — it's exact). */
  confidence: number | null;
  portion_basis: string | null;
}

/**
 * The nutrition fields a PATCH macro override can set (excludes `confidence`
 * and `portion_basis`, which aren't part of `EntryPatchInput` — `as const`
 * so the tuple's literal type narrows correctly when used to index it).
 */
export const NUTRITION_FIELD_KEYS = [
  'calories',
  'protein_g',
  'fat_g',
  'sat_fat_g',
  'carbs_g',
  'sugar_g',
  'fiber_g',
  'sodium_mg',
] as const satisfies readonly (keyof NutritionFields)[];

/**
 * A directly-stated nutrition panel supplied at creation (specs/modules/kitchen.md
 * § Directly-stated panel entries). The eight panel fields, each a number or
 * absent — an absent field is stored `null` (unknown), never coerced to `0`.
 * The caller has already done the arithmetic; the numbers ARE the answer, so no
 * estimator runs and no field is re-derived, defaulted, or rounded.
 */
export interface StatedMacros {
  calories?: number;
  protein_g?: number;
  fat_g?: number;
  sat_fat_g?: number;
  carbs_g?: number;
  sugar_g?: number;
  fiber_g?: number;
  sodium_mg?: number;
}

/** What the client POSTs as the entry JSON part of the multipart body. */
export interface EntryInput {
  ulid: string;
  /** Client clock; defaults to receive time when omitted. */
  logged_at?: string;
  note?: string;
  /** Optional recipe reference — triggers deterministic recipe-computed macros. */
  recipe_ulid?: string;
  component_quantities?: ComponentQuantity[];
  /**
   * Optional source-entry reference — a recent pill re-logs by cloning this
   * entry's label + base macros deterministically (source `reselect`, status
   * `estimated`, no model call; see specs/modules/kitchen.md § Reselect
   * cloning). Mutually exclusive with `recipe_ulid`. A note riding the same
   * POST is stored as a comment and does NOT trigger estimation.
   */
  reselect_of?: string;
  /**
   * Optional directly-stated panel (specs/modules/kitchen.md § Directly-stated
   * panel entries). Stored verbatim as the base macros of a born-`manual`,
   * terminal (`estimated`) entry that enqueues NO estimation. Mutually exclusive
   * with `recipe_ulid`, `reselect_of`, `component_quantities`, and photo parts.
   */
  macros?: StatedMacros;
  /**
   * Optional label (provenance/display) — honored ONLY alongside `macros`, where
   * it names the born-`manual` entry (e.g. what computed the panel). The other
   * creation shapes derive the label from their source (estimator / recipe /
   * cloned entry), so a label sent without `macros` is rejected rather than
   * silently dropped.
   */
  label?: string;
}

/**
 * Post-hoc portion rescale bound: `0 < portion_multiplier <= PORTION_MULTIPLIER_MAX`.
 * Mirrored by the migration CHECK and the PATCH body schema
 * (specs/modules/kitchen.md § Portion multiplier).
 */
export const PORTION_MULTIPLIER_MAX = 20;

/**
 * Backdating bounds for `logged_at` (specs/modules/kitchen.md § Logged-at
 * backdating). Relative to the server clock, so enforced at the API — not a
 * static DB CHECK. Future tolerance absorbs device-clock/timezone skew (EXIF
 * carries no zone); the past bound rejects a corrupt/typo'd stamp.
 */
export const LOGGED_AT_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000; // 24 hours
export const LOGGED_AT_MAX_AGE_MS = 5 * 365 * 24 * 60 * 60 * 1000; // ~5 years

/** What the client PATCHes onto an existing entry. */
export interface EntryPatchInput {
  note?: string;
  label?: string;
  /** Presence of ANY nutrition field marks this a manual macro override (terminal). */
  calories?: number;
  protein_g?: number;
  fat_g?: number;
  sat_fat_g?: number;
  carbs_g?: number;
  sugar_g?: number;
  fiber_g?: number;
  sodium_mg?: number;
  portion_basis?: string;
  /**
   * Post-hoc rescale of the base macros: `effective = base * portion_multiplier`.
   * Orthogonal to a macro override — never re-queues estimation, never changes
   * `source`, accepted on any entry. `0 < portion_multiplier <= PORTION_MULTIPLIER_MAX`.
   */
  portion_multiplier?: number;
  /**
   * Post-hoc backdating of the entry to the meal's actual moment (ISO date-time).
   * Orthogonal to every other axis — never re-queues estimation, never changes
   * `source`, accepted on any entry. Moving it re-buckets the entry (and its
   * effective macros) to a new day in every rollup. Bounded per
   * LOGGED_AT_FUTURE_SKEW_MS / LOGGED_AT_MAX_AGE_MS
   * (specs/modules/kitchen.md § Logged-at backdating).
   */
  logged_at?: string;
}

/** A row in kitchen.entries. */
export interface EntryRecord extends NutritionFields {
  ulid: string;
  logged_at: Date;
  received_at: Date;
  note: string | null;
  label: string | null;
  source: EstimationSource | null;
  status: EntryStatus;
  estimate_attempts: number;
  last_error: string | null;
  last_error_at: Date | null;
  recipe_ulid: string | null;
  component_quantities: ComponentQuantity[] | null;
  /**
   * Post-hoc portion rescale, default 1. The macro fields above are the BASE
   * (unscaled); every consumer computes effective = base * portion_multiplier
   * (specs/modules/kitchen.md § Portion multiplier).
   */
  portion_multiplier: number;
  /** Phase 2: the inventory item this entry depleted (set by the depletion matcher). */
  inventory_item_ulid: string | null;
  created_at: Date;
  updated_at: Date;
}

/** One uploaded photo part, held in memory only for the duration of one estimation attempt. */
export interface PhotoPart {
  data: Buffer;
  mimeType: string;
}

/** The model's raw structured output for one estimation attempt. */
export interface ModelEstimate {
  label: string;
  calories: number | null;
  protein_g: number | null;
  fat_g: number | null;
  sat_fat_g: number | null;
  carbs_g: number | null;
  sugar_g: number | null;
  fiber_g: number | null;
  sodium_mg: number | null;
  confidence: number;
  portion_basis: string;
}
