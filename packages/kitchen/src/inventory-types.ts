/**
 * Kitchen inventory types (phase 2 — receipts, labels, lexicon, stock, events).
 *
 * Wire contract for the client app: field names + shapes here are
 * authoritative and mirror specs/modules/kitchen.md § Phase 2. Keep them in
 * sync with the routes.
 */

import type { EntryRecord } from './types.js';

export type ShelfLifeClass =
  | 'pantry'
  | 'frozen'
  | 'fridge_long'
  | 'fridge_short'
  | 'produce'
  | 'very_perishable'
  // A cooked/assembled dish (a convert's output) — ages from its make date,
  // opening does not reset the clock. See inventory-derive SHELF_LIFE_WINDOWS.
  | 'prepared'
  | 'unknown';

export const SHELF_LIFE_CLASSES: readonly ShelfLifeClass[] = [
  'pantry',
  'frozen',
  'fridge_long',
  'fridge_short',
  'produce',
  'very_perishable',
  'prepared',
  'unknown',
];

/**
 * The made-food shelf-life classes a `convert` derived item may take (§
 * Shelf-life classes — "A `convert` derived item accepts only made-food
 * shelf-life classes"). `prepared` is the default when a caller names none.
 * A homemade item ages from its make date and has no sealed-package phase, so
 * only these classes model it honestly.
 */
export const CONVERT_SHELF_LIFE_CLASSES: readonly ShelfLifeClass[] = [
  'prepared',
  'produce',
  'very_perishable',
  'frozen',
];

/**
 * The package-durable shelf-life classes a `convert` derived item may NOT take.
 * Their clocks anchor to a still-sealed store package's unopened window (e.g.
 * `fridge_short` 14 d, `pantry` 365 d); a derived item is stocked/unopened by
 * construction, so one of these would stamp an absurd eat-by on a homemade dish.
 * `convert` rejects them with a `400` — a longer honest clock uses the
 * product-level day overrides instead. (`unknown` is neither made-food nor
 * package-durable and is not part of this guard.)
 */
export const PACKAGE_DURABLE_SHELF_LIFE_CLASSES: readonly ShelfLifeClass[] = [
  'pantry',
  'fridge_long',
  'fridge_short',
];

/**
 * The classes a **storage move** may name as a destination (§ Storage moves).
 * Every real class qualifies except `unknown`: a move states where the item now
 * lives, and `unknown` is not a place. An item whose class genuinely isn't known
 * reaches that through § Reconcile instead.
 */
export const STORAGE_MOVE_SHELF_LIFE_CLASSES: readonly ShelfLifeClass[] = SHELF_LIFE_CLASSES.filter(
  (cls) => cls !== 'unknown'
);

/**
 * What a counted package's seal encloses (§ count-vs-fraction) — counting and
 * being openable are independent axes, not alternatives:
 *
 * - `individual` — each unit carries its own seal (a can 3-pack, yogurt cups in a
 *   sleeve). Opening means "I broke ONE unit's seal": only that unit runs the
 *   perishable clock and the sealed remainder stays at the unopened window.
 * - `shared` — one seal encloses all the units, so the package is a CONTAINER
 *   that gets opened and also holds discrete units eaten one at a time (a 4-link
 *   vacuum pack, a sliced loaf, an egg carton, a tray of prepped portions).
 *   Opening puts the WHOLE remainder on the opened clock; finishing a unit
 *   re-seals nothing.
 *
 * Null is read as `individual` (the unmarked default, and the behavior the count
 * model shipped with) and stays null on a fraction-modeled item, where the notion
 * doesn't apply. Resolve it through `unitSealOf`, never inline.
 */
export type UnitSeal = 'individual' | 'shared';

export const UNIT_SEALS: readonly UnitSeal[] = ['individual', 'shared'];

export type InventoryState = 'stocked' | 'open' | 'finished' | 'tossed' | 'dismissed';

export const INVENTORY_STATES: readonly InventoryState[] = [
  'stocked',
  'open',
  'finished',
  'tossed',
  'dismissed',
];

export type BatchSource = 'receipt' | 'manual';
export type BatchStatus = 'parsing' | 'parsed' | 'failed';
export type LineMatchOutcome = 'pending' | 'matched' | 'unmatched' | 'skipped';

/**
 * Explicit inventory event types. `finished-unit` is the counted-item sibling of
 * `finished`: an integer decrement of one unit rather than a whole-item terminal
 * close (see § count-vs-fraction). `moved` is the odd one out — it is the only
 * event that changes an item's CLOCK without changing its state (§ Storage
 * moves): it re-anchors `eat_by` from the move date onto the destination class,
 * and deliberately leaves `state`/`opened_at` alone, because moving a sealed pack
 * between appliances does not open it and moving an open one does not re-seal it.
 */
export type InventoryEventType = 'opened' | 'finished' | 'finished-unit' | 'tossed' | 'moved';

export const INVENTORY_EVENT_TYPES: readonly InventoryEventType[] = [
  'opened',
  'finished',
  'finished-unit',
  'tossed',
  'moved',
];

/**
 * Where a product's nutrition panel came from (§ Per-unit edible grams and
 * panel provenance): a scanned label is authoritative for that SKU; a
 * reference table is correct for the food but generic for the SKU (the only
 * option for unpackaged produce, which carries no label); an estimate is a
 * guess. Orthogonal to basis — a label panel is normally per-serving and a
 * reference panel per-100g, but neither field implies the other.
 */
export type NutritionSource = 'label' | 'reference' | 'estimate';

export const NUTRITION_SOURCES: readonly NutritionSource[] = ['label', 'reference', 'estimate'];

/**
 * Reference nutrition per 100g on a product. Any field null = unknown.
 * The full nine-field dietary panel (§ Nutrition panel), including
 * `added_sugar_g` — US Nutrition Facts panels have printed "Includes Xg Added
 * Sugars" since the 2016 rule, so a label scan is the highest-confidence source
 * there is for it. This is a product-nutrition shape, distinct from
 * RecipeComponentMacros — the two are not conflated.
 */
export interface NutritionPer100g {
  calories: number | null;
  protein_g: number | null;
  fat_g: number | null;
  sat_fat_g: number | null;
  carbs_g: number | null;
  sodium_mg: number | null;
  fiber_g: number | null;
  sugar_g: number | null;
  added_sugar_g: number | null;
}

/** A row in kitchen.products. */
export interface ProductRecord {
  ulid: string;
  name: string;
  shelf_life_class: ShelfLifeClass;
  aliases: string[];
  nutrition_per_100g: NutritionPer100g | null;
  /**
   * Raw label capture (§ Nutrition panel — capture as printed, scale late):
   * grams per label serving + the per-serving panel, transcribed verbatim by
   * the label scan. Per-100g is DERIVED in code from these when present
   * (per_serving ÷ serving_size_g × 100); the model's own per-100g is kept
   * only as a fallback when the serving size is unreadable.
   */
  serving_size_g: number | null;
  nutrition_per_serving: NutritionPer100g | null;
  /** Opportunistic package accounting only — never feeds count-vs-fraction. */
  servings_per_container: number | null;
  /**
   * Vision-model packaging judgment (§ count-vs-fraction): 'counted' —
   * individually-sealed atomic units each opened separately; 'fraction' — a
   * single container drawn down; null — not enough info. A HINT the
   * unit-model judgment leans on; it never hard-sets a quantity.
   */
  unit_model_hint: 'counted' | 'fraction' | null;
  /**
   * Printed net content, converted DETERMINISTICALLY in code from the label's
   * transcribed {value, unit} (§ Prices' divisor): grams for weight-stated
   * packages, ml for volume-stated. The per-gram denominator for cost reads.
   */
  net_content_g: number | null;
  net_content_ml: number | null;
  /** The printed ingredients list; null when unknown. */
  ingredients: string | null;
  package_size: string | null;
  shelf_life_days_unopened: number | null;
  shelf_life_days_opened: number | null;
  /**
   * The edible mass of ONE physical unit of a counted product — one egg, one
   * can, one link (§ Per-unit edible grams and panel provenance). STATED,
   * never derived: `serving_size_g` is the label's serving, which equals one
   * unit only by coincidence, and `net_content_g ÷ units_total` (an item-level
   * quantity) includes inedible mass (shell, packing water). Null makes the
   * product ineligible for one-tap consume — never an error.
   */
  unit_edible_g: number | null;
  /** Where the nutrition panel came from; see `NutritionSource`. Null = unknown. */
  nutrition_source: NutritionSource | null;
  /**
   * The owner's assertion that EVERY panel field is ~0 at any realistic serving
   * (§ Nutritionally negligible products): spices, dried herbs, salt, vinegar,
   * black coffee, extracts. It clears `needs_nutrition` and makes the effective
   * panel read as zeros rather than nulls — a US spice jar carries no Nutrition
   * Facts panel at all, so no rescan can ever resolve the flag for it. Never
   * inferred, never backfilled.
   */
  nutrition_negligible: boolean;
  /**
   * Retirement stamp (§ Product corrections) — null while live. An archived
   * product leaves every listing and stops being a name-match candidate, but
   * stays resolvable by ULID forever so items, lexicon lines, and batch lines
   * that point at it never dangle.
   */
  archived_at: Date | null;
  /** Set when this row was retired INTO a survivor by a merge; else null. */
  merged_into: string | null;
  created_at: Date;
  updated_at: Date;
}

/** What a client POSTs to /products (or the label pipeline composes). */
export interface ProductInput {
  name: string;
  shelf_life_class?: ShelfLifeClass;
  aliases?: string[];
  nutrition_per_100g?: Partial<NutritionPer100g> | null;
  serving_size_g?: number | null;
  nutrition_per_serving?: Partial<NutritionPer100g> | null;
  servings_per_container?: number | null;
  unit_model_hint?: 'counted' | 'fraction' | null;
  net_content_g?: number | null;
  net_content_ml?: number | null;
  ingredients?: string | null;
  package_size?: string | null;
  shelf_life_days_unopened?: number | null;
  shelf_life_days_opened?: number | null;
  /** § Per-unit edible grams and panel provenance — see `ProductRecord`. STATED, never derived. */
  unit_edible_g?: number | null;
  /**
   * § Per-unit edible grams and panel provenance — see `ProductRecord`.
   * `ProductInput` serves two different doors with two different rules: a
   * name-key ENRICH (`upsertProductByName`, the label composer, the merge
   * fold) never lets this DOWNGRADE an existing `'label'` — those writes carry
   * no evidence against a scanned panel's authority. An explicit-ulid REPLACE
   * (`POST /products {ulid}`) is the owner stating the whole record, so the
   * stated value applies as given, downgrade included — see `upsertProduct`.
   */
  nutrition_source?: NutritionSource | null;
  /** § Nutritionally negligible products — see `ProductRecord`. */
  nutrition_negligible?: boolean;
  /**
   * Request-only, never stored: proceed with `nutrition_negligible` even though
   * the sodium guard refused (§ Nutritionally negligible products — § Sodium is
   * the exception that breaks the marker). The judgement it exists for is a
   * salt-shaped product whose realistic use genuinely contributes ~0 sodium — a
   * jar of flaked finishing salt used a few crystals at a time.
   */
  nutrition_negligible_override?: boolean;
}

/**
 * A `PATCH /products/:ulid` body (§ Product corrections). Partial by
 * definition: only the keys present change. Unlike every enrich path in the
 * module, an explicit `null` CLEARS — an enrich merges a guess that may simply
 * not have read a field, while a patch is the owner stating what is true.
 * The two nutrition panels merge per-field (a supplied field sets or, when
 * null, clears just that field; the whole panel clears only on
 * `nutrition_per_100g: null`).
 */
export interface ProductPatchInput {
  name?: string;
  shelf_life_class?: ShelfLifeClass;
  aliases?: string[];
  nutrition_per_100g?: Partial<NutritionPer100g> | null;
  serving_size_g?: number | null;
  nutrition_per_serving?: Partial<NutritionPer100g> | null;
  servings_per_container?: number | null;
  unit_model_hint?: 'counted' | 'fraction' | null;
  net_content_g?: number | null;
  net_content_ml?: number | null;
  ingredients?: string | null;
  package_size?: string | null;
  shelf_life_days_unopened?: number | null;
  shelf_life_days_opened?: number | null;
  /** § Per-unit edible grams and panel provenance — see `ProductRecord`. STATED, never derived. */
  unit_edible_g?: number | null;
  /**
   * § Per-unit edible grams and panel provenance — see `ProductRecord`. The
   * stated value APPLIES, including a downgrade FROM `'label'`: a `PATCH` is
   * the owner asserting a fact, not the automated gap-filler the
   * one-directional supersession rule exists to constrain (that rule guards
   * the enrich door only — see `resolveNutritionSource` in services/inventory.ts).
   */
  nutrition_source?: NutritionSource | null;
  nutrition_negligible?: boolean;
  /** Request-only, never stored — see `ProductInput`. */
  nutrition_negligible_override?: boolean;
}

/** What `POST /products/:ulid/merge` reports (§ Product corrections). */
export interface ProductMergeResult {
  /** The survivor, enriched from the loser. */
  product: ProductRecord;
  /** The retired loser (`archived_at` stamped, `merged_into` set). */
  merged: ProductRecord;
  relinked: { items: number; lexicon_lines: number; batch_lines: number };
}

/** A row in kitchen.receipt_lexicon. `product_ulid` is null on a skip marker. */
export interface LexiconRecord {
  ulid: string;
  store: string;
  line_text: string;
  product_ulid: string | null;
  package_size: string | null;
  shelf_life_class: ShelfLifeClass | null;
  /** True on a non-inventory skip marker: future receipts skip this line. */
  non_inventory: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface LexiconInput {
  store: string;
  line_text: string;
  product_ulid: string;
  package_size?: string | null;
  shelf_life_class?: ShelfLifeClass | null;
}

/** A row in kitchen.inventory_items. */
export interface InventoryItemRecord {
  ulid: string;
  product_ulid: string | null;
  raw_label: string | null;
  store: string | null;
  batch_ulid: string | null;
  state: InventoryState;
  /**
   * The STORED fraction. Authoritative only for a fraction-modeled item — for a
   * counted one the wire value is derived from the count (§ count-vs-fraction),
   * and this column is not the source of truth. Read it through
   * `onHandFractionOf`, never directly, on any path that can see both models.
   */
  on_hand_fraction: number;
  /**
   * Unit count model (§ count-vs-fraction): a package of discrete units (can
   * 3-pack, egg dozen, 4-link sausage pack, sliced loaf) tracks
   * `units_total`/`units_remaining` instead of `on_hand_fraction`, as ONE row (no
   * fan-out). Both null = fraction-modeled (the default, unchanged); both set
   * together — never one without the other. `unit_seal` then says what the
   * package seals.
   */
  units_total: number | null;
  units_remaining: number | null;
  /** What a counted package seals (§ count-vs-fraction); null = `individual`, and always null on a fraction item. */
  unit_seal: UnitSeal | null;
  needs_info: boolean;
  acquired_at: Date;
  opened_at: Date | null;
  closed_at: Date | null;
  /**
   * Date of the most recent recorded storage move (§ Storage moves) — from then
   * on the item's clock ANCHOR, so a move restarts the shelf-life window from the
   * move instead of resuming the window it was on. Only the latest move is
   * retained (only current storage governs the current clock); the full
   * transition history lives in `notes`.
   */
  storage_moved_at: Date | null;
  eat_by: Date | null;
  shelf_life_class: ShelfLifeClass | null;
  notes: string | null;
  /**
   * Set when this row was retired INTO a surviving item by a merge
   * (§ Item corrections) — the forward pointer a straggler reference follows,
   * and how a replayed merge tells "already done" (idempotent) from "merged
   * somewhere else" (a 409). Null on every live row.
   */
  merged_into: string | null;
  created_at: Date;
  updated_at: Date;
}

/** What a client POSTs to /inventory (manual/verbal item, or the seed port). */
export interface InventoryItemInput {
  ulid?: string;
  product_ulid?: string | null;
  raw_label?: string | null;
  store?: string | null;
  batch_ulid?: string | null;
  acquired_at?: string;
  on_hand_fraction?: number;
  /** Unit count (mutually exclusive with on_hand_fraction — see InventoryItemRecord). */
  units_total?: number;
  /** What the counted package seals (§ count-vs-fraction); requires `units_total`. */
  unit_seal?: UnitSeal;
  state?: InventoryState;
  needs_info?: boolean;
  shelf_life_class?: ShelfLifeClass | null;
  notes?: string | null;
}

/** The joined + derived view returned by the inventory read endpoints. */
export interface InventoryItemView {
  ulid: string;
  product_ulid: string | null;
  product_name: string | null;
  raw_label: string | null;
  store: string | null;
  batch_ulid: string | null;
  state: InventoryState;
  /**
   * How much is on hand, 0..1. For a counted item this is **derived** —
   * `units_remaining ÷ units_total` — never the stored column, so a pack with 1
   * of 4 units left reads `0.25` rather than a stale `1` (§ count-vs-fraction).
   */
  on_hand_fraction: number;
  units_total: number | null;
  units_remaining: number | null;
  /** What the counted package seals; `individual` when unstated, null on a fraction item. */
  unit_seal: UnitSeal | null;
  needs_info: boolean;
  /**
   * The linked product is missing nutrition data (§ Nutrition panel — no
   * panel, or a partial one): a label rescan is the obvious next action.
   * Distinct from `needs_info` (a scanned line with NO product match).
   */
  needs_nutrition: boolean;
  acquired_at: string;
  opened_at: string | null;
  closed_at: string | null;
  /** Date of the most recent storage move (§ Storage moves); null until one is recorded. */
  storage_moved_at: string | null;
  eat_by: string | null;
  shelf_life_class: ShelfLifeClass | null;
  days_until_eat_by: number | null;
  age_days: number | null;
  notes: string | null;
  /** Survivor this row was merged into (§ Item corrections); null on a live row. */
  merged_into: string | null;
  /** Derived-from provenance (§ Conversions) — null unless created by `convert`. */
  derived_from: DerivedFromView | null;
  created_at: string;
  updated_at: string;
}

/** One consumed source in a conversion's provenance. */
export interface DerivationSource {
  item_ulid: string;
  /** Amount consumed from that source, in ITS OWN unit (fraction 0..1 or a whole-unit count). */
  amount: number;
  amount_kind: 'fraction' | 'count';
}

/** A row in kitchen.inventory_derivations — provenance for one derived item. */
export interface InventoryDerivationRecord {
  ulid: string;
  derived_item_ulid: string;
  sources: DerivationSource[];
  /** Optional recipe/conversion reference that fixes the derived item's macros (provenance only). */
  recipe_ulid: string | null;
  created_at: Date;
}

/** The provenance shape embedded on a derived item's view. */
export interface DerivedFromView {
  sources: DerivationSource[];
  recipe_ulid: string | null;
}

/** A row in kitchen.purchase_batches. */
export interface PurchaseBatchRecord {
  ulid: string;
  source: BatchSource;
  store: string | null;
  /** True when a completed parse found no store (meta or header extraction). */
  store_undetermined: boolean;
  purchased_at: Date;
  status: BatchStatus;
  parse_attempts: number;
  last_error: string | null;
  last_error_at: Date | null;
  /** The receipt's printed grand total in integer cents (§ Prices); null = unreadable. */
  total_cents: number | null;
  created_at: Date;
  updated_at: Date;
}

/** The wire view for a purchase batch (dates as ISO strings). */
export interface PurchaseBatchView {
  ulid: string;
  source: BatchSource;
  store: string | null;
  store_undetermined: boolean;
  purchased_at: string;
  status: BatchStatus;
  parse_attempts: number;
  last_error: string | null;
  total_cents: number | null;
  created_at: string;
  updated_at: string;
}

/** What a client POSTs (the `receipt` meta part) to /receipts. */
export interface ReceiptInput {
  ulid: string;
  store?: string;
  purchased_at?: string;
}

/** A row in kitchen.purchase_batch_lines. */
export interface BatchLineRecord {
  ulid: string;
  batch_ulid: string;
  raw_text: string;
  /** Physical-unit count the line represents (≥ 1; a multibuy line fans out to N items). */
  quantity: number;
  /** The line's printed extended price in integer cents (§ Prices); null = unreadable. */
  price_cents: number | null;
  match_outcome: LineMatchOutcome;
  product_ulid: string | null;
  inventory_item_ulid: string | null;
  created_at: Date;
}

export interface BatchLineView {
  ulid: string;
  batch_ulid: string;
  raw_text: string;
  quantity: number;
  price_cents: number | null;
  match_outcome: LineMatchOutcome;
  product_ulid: string | null;
  inventory_item_ulid: string | null;
  created_at: string;
}

/**
 * Open needs-info items rendered as a one-time question (digest/chat),
 * deduplicated by `(store, normalized line_text)`. A multi-quantity receipt
 * line is one question covering N physical units.
 */
export interface InventoryQuestion {
  /** Representative (earliest-acquired) item to target for a label scan / dismissal. */
  item_ulid: string;
  /** Every item this grouped question covers (≥ 1). */
  item_ulids: string[];
  /** `item_ulids.length` — the number of physical units behind this line. */
  count: number;
  raw_label: string | null;
  store: string | null;
  /** Earliest `acquired_at` among the covered items. */
  acquired_at: string;
  question: string;
}

/** Result of a label scan: the resolved item + product + how many items it cleared. */
export interface LabelResolution {
  item: InventoryItemView;
  product: ProductRecord;
  /** Total items resolved: the scanned item plus fanned-out siblings (≥ 1). */
  resolved_count: number;
}

/** Result of a dismissal: the dismissed item + how many it cleared + the flag. */
export interface DismissResolution {
  item: InventoryItemView;
  /** Total items dismissed: the scanned item plus fanned-out siblings (≥ 1). */
  dismissed_count: number;
  /** Whether a non-inventory skip marker was written (and siblings fanned out). */
  non_inventory: boolean;
}

/**
 * Per-table relink counts from an item merge (§ Item corrections). Every one is
 * a real dependent of `kitchen.inventory_items`:
 *
 * - `entries` — `kitchen.entries.inventory_item_ulid`, the consumption entries
 *   the depletion matcher (or a `consume` tap) attributed to the loser.
 * - `batch_lines` — `kitchen.purchase_batch_lines.inventory_item_ulid`, the
 *   receipt line whose representative unit the loser was.
 * - `derivations` — `kitchen.inventory_derivations.derived_item_ulid`, the
 *   conversion that MADE the loser. 1:1 by construction, so it moves only when
 *   the survivor has no provenance of its own; otherwise `0`.
 * - `derivation_sources` — conversions that SPENT the loser as an input, i.e.
 *   `inventory_derivations.sources[].item_ulid` rewritten in place.
 */
export interface ItemRelinkCounts {
  entries: number;
  batch_lines: number;
  derivations: number;
  derivation_sources: number;
}

/** Result of an item merge: the survivor, the retired loser, and what moved. */
export interface ItemMergeResult {
  item: InventoryItemView;
  merged: InventoryItemView;
  relinked: ItemRelinkCounts;
}

/** One uploaded photo part, held in memory only for the request. */
export interface InventoryPhotoPart {
  data: Buffer;
  mimeType: string;
}

/** The receipt model's raw structured output: one line per purchased item. */
export interface ParsedReceiptLine {
  text: string;
  /**
   * Physical-unit count for a multi-quantity/multibuy line (a `N @ price`
   * marker or a qty column). Defaults to 1; the parse fans out to N items.
   */
  quantity?: number;
  /**
   * The model's judgment that the line is CLEARLY non-food (a receipt
   * non-grocery marker or unambiguous non-grocery text). Conservative: left
   * false/undefined on any ambiguity. A durable lexicon mapping overrides it.
   */
  non_food?: boolean;
  /**
   * The line's printed EXTENDED price in integer cents (§ Prices) — what was
   * paid for the line's units, transcribed as printed; for a multibuy line
   * the printed line total, never a computed quantity × unit price. Null =
   * unreadable / not printed.
   */
  price_cents?: number | null;
}

export interface ParsedReceipt {
  store: string | null;
  /** The receipt's printed grand total in integer cents (§ Prices); null = unreadable. */
  total_cents?: number | null;
  lines: ParsedReceiptLine[];
}

/**
 * The label model's raw structured output. When several photos are supplied
 * they are complementary views of one product (front + panels), so this is one
 * merged extraction, not one-per-photo.
 */
export interface ParsedLabel {
  name: string | null;
  shelf_life_class: ShelfLifeClass | null;
  package_size: string | null;
  /** Grams per printed label serving, transcribed verbatim (no model math). */
  serving_size_g: number | null;
  /** Printed "servings per container", opportunistic — never feeds count-vs-fraction. */
  servings_per_container: number | null;
  /** The label's per-serving panel exactly as printed; null field = unreadable. */
  nutrition_per_serving: Partial<NutritionPer100g> | null;
  /** ONLY a printed per-100g column, transcribed — never the model's own conversion. */
  nutrition_per_100g: Partial<NutritionPer100g> | null;
  /** Whatever ingredient information is legible — full panel, partial, or callouts; null only when none. */
  ingredients: string | null;
  /** Packaging judgment (§ count-vs-fraction hint): sealed-multipack vs single divisible container. */
  unit_model_hint: 'counted' | 'fraction' | null;
  /**
   * The package's printed net content, transcribed as a raw {value, unit}
   * pair (§ Prices' divisor) — e.g. {454, "g"}, {64, "fl oz"}. Deterministic
   * CODE converts to net_content_g/_ml; the model never converts units.
   * Null when no net content is legible.
   */
  net_content: { value: number; unit: string } | null;
  aliases: string[];
  /**
   * The edible mass of ONE physical unit, ONLY when the package prints that
   * exact figure as its own distinct number (§ Per-unit edible grams and panel
   * provenance) — e.g. a per-item "Net Wt X g" on an individually-wrapped
   * unit. Transcription, never arithmetic: NOT the serving size, and NOT net
   * content divided by a count. Null in the overwhelming majority of scans,
   * including whenever the only way to reach a number would be to compute it.
   */
  unit_edible_g: number | null;
}

/**
 * A `POST /inventory/:ulid/events` body. `fraction` means something different per
 * type (absolute remainder on `opened`, amount tossed on `tossed`, ignored on the
 * finishers); `to` applies to `moved` alone and is required there — it names the
 * shelf-life class the item moved INTO (§ Storage moves). `at` is the date of the
 * ACT, not of the intention: a thaw reported as yesterday anchors to yesterday
 * even if the decision to thaw was made two days earlier.
 */
export interface InventoryEventInput {
  type: InventoryEventType;
  fraction?: number;
  to?: ShelfLifeClass;
  at?: string;
}

/** What the free-text resolver decided for a remark. `recount` routes to § Reconcile, not the event machine. */
export interface ResolvedEvent {
  type: InventoryEventType | 'recount';
  fraction: number | null;
}

export interface EventResolution {
  matched: boolean;
  item?: InventoryItemView;
  event?: ResolvedEvent;
}

/**
 * A § Reconcile correction (PATCH /inventory/:ulid) — an OBSERVATION of
 * reality, never a consumption event. Quantities/model/state/identity are set
 * directly; clocks are never inferred (`opened_at` moves only when explicitly
 * supplied, and a corrected `stocked` state clears it); `eat_by` re-derives
 * from the corrected truth and is never settable. `units_total: null` reverts a
 * counted item to the fraction model; a number (re)classifies it as counted.
 *
 * It reaches every field observation can settle, because a verb documented as
 * reconciling the ledger to reality that can't reach a wrong field is only half a
 * verb. The one boundary that matters: **`shelf_life_class` here is a class
 * CORRECTION, not a storage move.** It says "this was always a fridge item; I
 * recorded the wrong class," so it re-derives against the item's EXISTING anchor.
 * "It entered the fridge on the 8th" is a `moved` event (§ Storage moves), which
 * re-anchors. Using one for the other either under-reports urgency by however long
 * the item sat in its previous storage, or fabricates a transition that never
 * happened.
 */
export interface ReconcileInput {
  on_hand_fraction?: number;
  units_total?: number | null;
  units_remaining?: number | null;
  /** What the counted package seals (§ count-vs-fraction); refused on a fraction item. */
  unit_seal?: UnitSeal;
  state?: 'stocked' | 'open';
  opened_at?: string | null;
  /** A class CORRECTION — re-derives against the existing anchor, never re-anchors. */
  shelf_life_class?: ShelfLifeClass;
  /** Re-queue (`true`) or clear (`false`) the open-question flag. */
  needs_info?: boolean;
  /** Relink to a different (live) product, or `null` to unlink. */
  product_ulid?: string | null;
  /** Free-text context appended to the auto-written `reconciled …` notes line. */
  notes?: string;
}

// ── Conversions (prep transforms — § Conversions) ───────────────────────────

/**
 * One source consumed by a conversion. `amount` is interpreted per the
 * SOURCE item's own on-hand model: an integer unit count for a counted item,
 * a fraction (0..1) for a divisible one. Omitted = fully consumes the source
 * (the whole remaining count, or the whole remaining fraction).
 */
export interface ConversionSourceInput {
  item_ulid: string;
  amount?: number;
}

/** The new item a conversion creates. Exactly one of on_hand_fraction/units_total applies. */
export interface ConversionDerivedInput {
  /**
   * Optional client-supplied ULID for the derived item — and, when supplied,
   * the conversion's **idempotency key** (§ Conversions § Retries). Omit it and
   * the ULID is minted server-side, which leaves the verb non-deduplicating on
   * purpose ("I made another batch" is an ordinary repeated act). Supply it and
   * a replay writes nothing: no source spent twice, no second derived item.
   */
  ulid?: string;
  name: string;
  shelf_life_class?: ShelfLifeClass;
  on_hand_fraction?: number;
  units_total?: number;
  /**
   * What a counted batch's package seals (§ count-vs-fraction): `shared` for a
   * tray of portions under one lid, `individual` (the default) for separately
   * lidded jars. Requires `units_total`.
   */
  unit_seal?: UnitSeal;
  store?: string | null;
  notes?: string | null;
  acquired_at?: string;
  /** Optional recipe/conversion that fixes the derived item's macros (provenance only). */
  recipe_ulid?: string | null;
}

/** What a client POSTs to /inventory/convert. */
export interface ConvertInput {
  /** Optional: omit/empty for a source-less "I made this" conversion. */
  sources?: ConversionSourceInput[];
  derived: ConversionDerivedInput;
  at?: string;
}

/** Response of a conversion: the decremented sources + the new derived item + its provenance. */
export interface ConvertResult {
  sources: InventoryItemView[];
  derived: InventoryItemView;
  derivation: InventoryDerivationRecord;
  /**
   * False on an idempotent replay of a caller-supplied `derived.ulid` — the
   * ledger was not touched again. Always true when the ULID is server-minted.
   */
  created: boolean;
}

// ── Consume from inventory (§ Consume from inventory) ───────────────────────

/**
 * What a client POSTs to `/inventory/:ulid/consume` (`:ulid` is the ITEM).
 * `ulid` here is the ENTRY's client-generated ULID — the idempotency key for
 * the whole atomic action (a replay creates no duplicate entry and does not
 * deplete the item again). `quantity` only applies to a counted item (whole
 * sealed units consumed in this one tap, default 1); a fraction-modeled item
 * always fully finishes in one consume, so `quantity` must be omitted or 1
 * there.
 */
export interface ConsumeInput {
  ulid: string;
  quantity?: number;
  at?: string;
}

/**
 * Response of `POST /inventory/:ulid/consume`: the created consumption entry
 * (exact known macros, source `reselect`, status `estimated`) plus the
 * depleted item, written in ONE atomic operation.
 */
export interface ConsumeResult {
  entry: EntryRecord;
  item: InventoryItemView;
  /** False on an idempotent replay of `ulid` — neither table was touched again. */
  created: boolean;
}

// ── Stated-weight consumption (§ Stated-weight consumption) ─────────────────

/**
 * What a client POSTs to `/inventory/:ulid/consumed` — a KNOWN weight or
 * fraction eaten off an open, DIVISIBLE (fraction-modeled) item. Distinct from
 * `POST /inventory/:ulid/consume` (§ Consume from inventory), which is a
 * one-tap action for an item whose macros AND portion are already both known:
 * this is for the ordinary case where a caller measured what left the
 * container, but the item itself carries no such provenance, and reaching for
 * `PATCH /inventory/:ulid` (§ Reconcile) would misrecord an eaten amount as an
 * observation that the ledger was wrong.
 *
 * Exactly one of `amount_g` / `fraction` is required. Both name a DECREMENT —
 * the amount EATEN, mirroring `tossed`'s "amount tossed" fraction semantics
 * (§ API `POST /inventory/:ulid/events`), never `opened`'s absolute-remainder
 * one. `amount_g` needs the linked product's `net_content_g` as a mass basis;
 * where it is absent the request is refused (`400`) rather than scaled
 * against an invented denominator — pass `fraction` directly instead.
 *
 * `entry_ulid`, when supplied, is an ALREADY-LOGGED consuming journal entry's
 * ulid (this endpoint never creates one): the depletion and the link
 * (`kitchen.entries.inventory_item_ulid`) commit in ONE transaction, and it
 * doubles as the idempotency key for a retry — a replay neither re-links nor
 * re-depletes. Omitted, the depletion still records as consumption; it is
 * simply not linked to one specific journal entry.
 */
export interface StatedConsumeInput {
  amount_g?: number;
  fraction?: number;
  entry_ulid?: string;
  at?: string;
}

/** Response of `POST /inventory/:ulid/consumed`. */
export interface StatedConsumeResult {
  item: InventoryItemView;
  /** The linked consuming entry, when `entry_ulid` was supplied; else null. */
  entry: EntryRecord | null;
  /**
   * True only when this call freshly linked `entry_ulid` to the item — false
   * when no `entry_ulid` was supplied, and false on an idempotent replay
   * (found already linked; neither side was re-applied).
   */
  linked: boolean;
}

// ── Price history (§ Price history) ──────────────────────────────────────────

/**
 * Which source supplied the size a price point normalized by, most-specific
 * first (§ Price history): a measure printed on the line itself, the lexicon's
 * package size for that store's line text, the product's label-derived net
 * content, or the product's package-size string. `null` = none did, and both
 * `cents_per_100*` are then null — an unknown divisor is never guessed.
 */
export type UnitBasis = 'line' | 'lexicon' | 'product_net_content' | 'product_package_size' | null;

/**
 * One recorded purchase of a product, normalized for comparison. Derived
 * entirely at read time from a batch line, its batch, the lexicon, and the
 * product — nothing here is stored (§ Price history).
 */
export interface PricePoint {
  line_ulid: string;
  batch_ulid: string;
  /** The batch's purchase date (ISO date). */
  purchased_at: string;
  store: string | null;
  /** The receipt line as printed — the measure a weighed/sized line carries lives here. */
  raw_text: string;
  /** Physical units the line covers. */
  quantity: number;
  /** The line's printed extended price (§ Prices); null = unreadable, never 0. */
  price_cents: number | null;
  /** `price_cents / quantity` — the per-physical-unit price; null when unpriced. */
  package_price_cents: number | null;
  unit_basis: UnitBasis;
  /** Grams the package normalized to (weight-stated packages only). */
  unit_grams: number | null;
  /** Millilitres the package normalized to (volume-stated packages only). */
  unit_millilitres: number | null;
  cents_per_100g: number | null;
  cents_per_100ml: number | null;
}

/** Response of `GET /products/:ulid/prices`. */
export interface PriceHistoryView {
  product_ulid: string;
  product_name: string;
  points: PricePoint[];
  count: number;
}

// ── Waste costing (§ Waste costing) ─────────────────────────────────────────

/**
 * How a waste row's cost was attributed: the item's OWN batch line (what was
 * actually paid for that package), the product's nearest priced purchase, or
 * `unknown` — no priced purchase exists, so the cost is null rather than a
 * fabricated 0.
 */
export type WasteCostBasis = 'batch_line' | 'product_price' | 'unknown';

/** One recorded toss with its cost attributed (§ Waste costing). */
export interface WasteRow {
  item_ulid: string;
  product_ulid: string | null;
  /** The product name, falling back to the item's raw label. */
  product_name: string | null;
  store: string | null;
  /** ISO date the toss was recorded for. */
  tossed_at: string;
  /** Package fraction discarded; null when the amount was unrecoverable. */
  amount_fraction: number | null;
  /** Sealed units discarded (counted items only); null otherwise. */
  units: number | null;
  /** True when this toss closed the item (terminal `tossed`). */
  terminal: boolean;
  /** Null on an unknown cost — NEVER 0 (§ Waste costing). */
  cost_cents: number | null;
  cost_basis: WasteCostBasis;
  /** The batch line the cost came from; null when unknown. */
  price_line_ulid: string | null;
  /** That line's purchase date (ISO date); null when unknown. */
  priced_at: string | null;
}

/**
 * Response of `GET /inventory/waste`. `totals.cost_cents` sums ONLY the rows
 * with a known cost, and `cost_unknown_rows` counts the rest — a partial total
 * that says how partial it is, never a whole-looking total that quietly drops
 * rows.
 */
export interface WasteReportView {
  waste: WasteRow[];
  count: number;
  totals: {
    rows: number;
    cost_cents: number;
    cost_unknown_rows: number;
  };
}
