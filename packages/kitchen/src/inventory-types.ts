/**
 * Kitchen inventory types (phase 2 — receipts, labels, lexicon, stock, events).
 *
 * Wire contract for the client app: field names + shapes here are
 * authoritative and mirror specs/modules/kitchen.md § Phase 2. Keep them in
 * sync with the routes.
 */

export type ShelfLifeClass =
  | 'pantry'
  | 'frozen'
  | 'fridge_long'
  | 'fridge_short'
  | 'produce'
  | 'very_perishable'
  | 'unknown';

export const SHELF_LIFE_CLASSES: readonly ShelfLifeClass[] = [
  'pantry',
  'frozen',
  'fridge_long',
  'fridge_short',
  'produce',
  'very_perishable',
  'unknown',
];

export type InventoryState = 'stocked' | 'open' | 'finished' | 'tossed';

export const INVENTORY_STATES: readonly InventoryState[] = ['stocked', 'open', 'finished', 'tossed'];

export type BatchSource = 'receipt' | 'manual';
export type BatchStatus = 'parsing' | 'parsed' | 'failed';
export type LineMatchOutcome = 'pending' | 'matched' | 'unmatched';

/** Explicit inventory event types (state-changing). */
export type InventoryEventType = 'opened' | 'finished' | 'tossed';

export const INVENTORY_EVENT_TYPES: readonly InventoryEventType[] = ['opened', 'finished', 'tossed'];

/** Reference nutrition per 100g on a product. Any field null = unknown. */
export interface NutritionPer100g {
  calories: number | null;
  protein_g: number | null;
  fat_g: number | null;
  sat_fat_g: number | null;
  carbs_g: number | null;
  sodium_mg: number | null;
}

/** A row in kitchen.products. */
export interface ProductRecord {
  ulid: string;
  name: string;
  shelf_life_class: ShelfLifeClass;
  aliases: string[];
  nutrition_per_100g: NutritionPer100g | null;
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
  package_size?: string | null;
  shelf_life_days_unopened?: number | null;
  shelf_life_days_opened?: number | null;
}

/** A row in kitchen.receipt_lexicon. */
export interface LexiconRecord {
  ulid: string;
  store: string;
  line_text: string;
  product_ulid: string;
  package_size: string | null;
  shelf_life_class: ShelfLifeClass | null;
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
  needs_info: boolean;
  acquired_at: string;
  opened_at: string | null;
  closed_at: string | null;
  eat_by: string | null;
  shelf_life_class: ShelfLifeClass | null;
  days_until_eat_by: number | null;
  age_days: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** A row in kitchen.purchase_batches. */
export interface PurchaseBatchRecord {
  ulid: string;
  source: BatchSource;
  store: string | null;
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
  match_outcome: LineMatchOutcome;
  product_ulid: string | null;
  inventory_item_ulid: string | null;
  created_at: Date;
}

export interface BatchLineView {
  ulid: string;
  batch_ulid: string;
  raw_text: string;
  match_outcome: LineMatchOutcome;
  product_ulid: string | null;
  inventory_item_ulid: string | null;
  created_at: string;
}

/** An open needs-info item rendered as a one-time question (digest/chat). */
export interface InventoryQuestion {
  item_ulid: string;
  raw_label: string | null;
  store: string | null;
  acquired_at: string;
  question: string;
}

/** One uploaded photo part, held in memory only for the request. */
export interface InventoryPhotoPart {
  data: Buffer;
  mimeType: string;
}

/** The receipt model's raw structured output: one line per purchased item. */
export interface ParsedReceiptLine {
  text: string;
}

export interface ParsedReceipt {
  store: string | null;
  lines: ParsedReceiptLine[];
}

/** The label model's raw structured output for a single package panel. */
export interface ParsedLabel {
  name: string | null;
  shelf_life_class: ShelfLifeClass | null;
  package_size: string | null;
  nutrition_per_100g: Partial<NutritionPer100g> | null;
  aliases: string[];
}

/** What the free-text resolver decided for a remark. */
export interface ResolvedEvent {
  type: InventoryEventType;
  fraction: number | null;
}

export interface EventResolution {
  matched: boolean;
  item?: InventoryItemView;
  event?: ResolvedEvent;
}
