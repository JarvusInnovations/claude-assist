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
 * Explicit inventory event types (state-changing). `finished-unit` is the
 * counted-item sibling of `finished`: an integer decrement of one sealed unit
 * rather than a whole-item terminal close (see § count-vs-fraction principle).
 */
export type InventoryEventType = 'opened' | 'finished' | 'finished-unit' | 'tossed';

export const INVENTORY_EVENT_TYPES: readonly InventoryEventType[] = [
  'opened',
  'finished',
  'finished-unit',
  'tossed',
];

/**
 * Reference nutrition per 100g on a product. Any field null = unknown.
 * The full dietary panel: the six fields an entry tracks plus fiber_g/sugar_g
 * (panels state them and they matter for the module's dietary purpose). This is
 * a product-nutrition shape, distinct from RecipeComponentMacros — the two are
 * not conflated.
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
}

/** A row in kitchen.products. */
export interface ProductRecord {
  ulid: string;
  name: string;
  shelf_life_class: ShelfLifeClass;
  aliases: string[];
  nutrition_per_100g: NutritionPer100g | null;
  /** The printed ingredients list; null when unknown. */
  ingredients: string | null;
  package_size: string | null;
  shelf_life_days_unopened: number | null;
  shelf_life_days_opened: number | null;
  created_at: Date;
  updated_at: Date;
}

/** What a client POSTs to /products (or the label pipeline composes). */
export interface ProductInput {
  name: string;
  shelf_life_class?: ShelfLifeClass;
  aliases?: string[];
  nutrition_per_100g?: Partial<NutritionPer100g> | null;
  ingredients?: string | null;
  package_size?: string | null;
  shelf_life_days_unopened?: number | null;
  shelf_life_days_opened?: number | null;
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
  on_hand_fraction: number;
  /**
   * Sealed-unit count model (§ count-vs-fraction principle): a discrete
   * multipack of individually-sealed atomic units (can 3-pack, egg dozen,
   * sausage-link pack, yogurt 4-pack) tracks `units_total`/`units_remaining`
   * instead of `on_hand_fraction`, as ONE row (no fan-out). Both null =
   * fraction-modeled (the default, unchanged); both set together — never one
   * without the other.
   */
  units_total: number | null;
  units_remaining: number | null;
  needs_info: boolean;
  acquired_at: Date;
  opened_at: Date | null;
  closed_at: Date | null;
  eat_by: Date | null;
  shelf_life_class: ShelfLifeClass | null;
  notes: string | null;
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
  /** Sealed-unit count (mutually exclusive with on_hand_fraction — see InventoryItemRecord). */
  units_total?: number;
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
  on_hand_fraction: number;
  units_total: number | null;
  units_remaining: number | null;
  needs_info: boolean;
  acquired_at: string;
  opened_at: string | null;
  closed_at: string | null;
  eat_by: string | null;
  shelf_life_class: ShelfLifeClass | null;
  days_until_eat_by: number | null;
  age_days: number | null;
  notes: string | null;
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
}

export interface ParsedReceipt {
  store: string | null;
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
  nutrition_per_100g: Partial<NutritionPer100g> | null;
  /** The printed ingredients list when a photo shows it; null otherwise. */
  ingredients: string | null;
  aliases: string[];
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
 * reality, never a consumption event. Quantities/model/state are set
 * directly; clocks are never inferred (`opened_at` moves only when explicitly
 * supplied, and a corrected `stocked` state clears it); `eat_by` re-derives
 * from the corrected truth. `units_total: null` reverts a counted item to the
 * fraction model; a number (re)classifies it as counted.
 */
export interface ReconcileInput {
  on_hand_fraction?: number;
  units_total?: number | null;
  units_remaining?: number | null;
  state?: 'stocked' | 'open';
  opened_at?: string | null;
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
  name: string;
  shelf_life_class?: ShelfLifeClass;
  on_hand_fraction?: number;
  units_total?: number;
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
