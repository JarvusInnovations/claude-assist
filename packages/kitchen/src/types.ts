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

/** Per-100g macro reference for one recipe ingredient. */
export interface RecipeComponentMacros {
  calories: number;
  protein_g: number;
  sat_fat_g: number;
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

/** Flattened nutrition estimate carried on an entry. Unknown fields are null, never 0. */
export interface NutritionFields {
  calories: number | null;
  protein_g: number | null;
  fat_g: number | null;
  sat_fat_g: number | null;
  carbs_g: number | null;
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
  'sodium_mg',
] as const satisfies readonly (keyof NutritionFields)[];

/** What the client POSTs as the entry JSON part of the multipart body. */
export interface EntryInput {
  ulid: string;
  /** Client clock; defaults to receive time when omitted. */
  logged_at?: string;
  note?: string;
  /** Optional recipe reference — triggers deterministic recipe-computed macros. */
  recipe_ulid?: string;
  component_quantities?: ComponentQuantity[];
}

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
  sodium_mg?: number;
  portion_basis?: string;
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
  sodium_mg: number | null;
  confidence: number;
  portion_basis: string;
}
