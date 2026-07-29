/**
 * Inventory stores (phase 2). Interface + Postgres implementation over the
 * `kitchen` schema. `InventoryStore` is an interface so the pipeline + routes
 * are testable without Postgres (see inventory-memory-store.ts); the memory
 * and pg implementations move in lockstep. Mirrors store.ts's shape.
 */

import type postgres from 'postgres';
import type {
  BatchLineRecord,
  BatchSource,
  BatchStatus,
  DerivationSource,
  InventoryDerivationRecord,
  InventoryItemRecord,
  InventoryState,
  ItemRelinkCounts,
  LexiconRecord,
  LineMatchOutcome,
  NutritionPer100g,
  ProductRecord,
  PurchaseBatchRecord,
  ShelfLifeClass,
  UnitSeal,
} from './inventory-types.js';
import { deriveEatBy, normalizeLexiconLine } from './inventory-derive.js';

// ── Normalized insert payloads ───────────────────────────────────────────────

export interface NewProduct {
  ulid: string;
  name: string;
  shelf_life_class: ShelfLifeClass;
  aliases: string[];
  nutrition_per_100g: NutritionPer100g | null;
  serving_size_g?: number | null;
  nutrition_per_serving?: NutritionPer100g | null;
  servings_per_container?: number | null;
  unit_model_hint?: 'counted' | 'fraction' | null;
  net_content_g?: number | null;
  net_content_ml?: number | null;
  ingredients: string | null;
  package_size: string | null;
  shelf_life_days_unopened: number | null;
  shelf_life_days_opened: number | null;
  /** § Nutritionally negligible products; defaults false when omitted. */
  nutrition_negligible?: boolean;
}

export interface ProductPatch {
  name?: string;
  shelf_life_class?: ShelfLifeClass;
  aliases?: string[];
  nutrition_per_100g?: NutritionPer100g | null;
  serving_size_g?: number | null;
  nutrition_per_serving?: NutritionPer100g | null;
  servings_per_container?: number | null;
  unit_model_hint?: 'counted' | 'fraction' | null;
  net_content_g?: number | null;
  net_content_ml?: number | null;
  ingredients?: string | null;
  package_size?: string | null;
  shelf_life_days_unopened?: number | null;
  shelf_life_days_opened?: number | null;
  nutrition_negligible?: boolean;
}

/** Per-table relink counts from a product merge (§ Product corrections). */
export interface ProductRelinkCounts {
  items: number;
  lexicon_lines: number;
  batch_lines: number;
}

/**
 * The survivor-side gap fill of an item merge (§ Item corrections) — the only
 * item fields a merge writes on the survivor, and only where the survivor's own
 * value is null. Quantities, clocks, and notes are deliberately absent: a merge
 * asserts the two rows are ONE package, so summing quantities would manufacture
 * stock and importing the loser's clock is the artifact that made the duplicate
 * misreport in the first place.
 */
export interface ItemIdentityPatch {
  product_ulid?: string | null;
  raw_label?: string | null;
  store?: string | null;
  batch_ulid?: string | null;
  shelf_life_class?: ShelfLifeClass | null;
}

export interface NewLexicon {
  ulid: string;
  store: string;
  line_text: string;
  /** Null on a non-inventory skip marker. */
  product_ulid: string | null;
  package_size: string | null;
  shelf_life_class: ShelfLifeClass | null;
  /** True on a non-inventory skip marker; defaults false for a product mapping. */
  non_inventory?: boolean;
}

export interface NewItem {
  ulid: string;
  product_ulid: string | null;
  raw_label: string | null;
  store: string | null;
  batch_ulid: string | null;
  state: InventoryState;
  on_hand_fraction: number;
  /** Unit count model (both null = fraction-modeled). See InventoryItemRecord. */
  units_total?: number | null;
  units_remaining?: number | null;
  /** What the counted package seals; null = `individual` (§ count-vs-fraction). */
  unit_seal?: UnitSeal | null;
  needs_info: boolean;
  acquired_at: Date;
  eat_by: Date | null;
  shelf_life_class: ShelfLifeClass | null;
  notes: string | null;
}

export interface ItemStateUpdate {
  state: InventoryState;
  opened_at?: Date | null;
  closed_at?: Date | null;
  on_hand_fraction?: number;
  /**
   * Present only when mutating a counted item's remaining-units count; null
   * (reconcile only) reverts the item to the fraction model.
   */
  units_remaining?: number | null;
  /**
   * Present only on a reconcile reclassify (§ Reconcile): a count makes the
   * item counted, null reverts it to the fraction model. Events never set it.
   */
  units_total?: number | null;
  /** Reconcile only: what the counted package seals; null clears it with the count. */
  unit_seal?: UnitSeal | null;
  /** Set by a `moved` event (§ Storage moves) and by a class correction on reconcile. */
  shelf_life_class?: ShelfLifeClass | null;
  /** Stamped by a `moved` event — the item's new clock anchor (§ Storage moves). */
  storage_moved_at?: Date | null;
  /** Reconcile only: re-queue or clear the open-question flag (§ Reconcile). */
  needs_info?: boolean;
  /** Reconcile only: relink to a different live product, or null to unlink. */
  product_ulid?: string | null;
  eat_by?: Date | null;
  /** Replacement notes value (e.g. with a waste line appended); omitted = unchanged. */
  notes?: string;
}

/** What the pipeline hands the store to persist one conversion's provenance. */
export interface NewDerivation {
  ulid: string;
  derived_item_ulid: string;
  sources: DerivationSource[];
  recipe_ulid: string | null;
}

/** One conversion source's pre-computed decrement, applied inside `applyConversion`. */
export interface ConversionSourceWrite {
  item_ulid: string;
  update: ItemStateUpdate;
}

/**
 * The complete set of writes one conversion performs (§ Conversions §
 * Atomicity). The service decides WHAT each write is — how much comes off each
 * source, the derived item's clock, the provenance list — and hands the whole
 * set here so the store can apply it as one unit. Sources are applied in the
 * order given, matching the order the service validated and planned them in.
 */
export interface ConversionWrite {
  sources: ConversionSourceWrite[];
  derived: NewItem;
  derivation: NewDerivation;
}

export interface ConversionWriteResult {
  /** The decremented sources, in the order they were supplied. */
  sources: InventoryItemRecord[];
  derived: InventoryItemRecord;
  derivation: InventoryDerivationRecord;
}

export interface ResolveNeedsInfo {
  product_ulid: string;
  shelf_life_class: ShelfLifeClass | null;
  eat_by: Date | null;
}

export interface NewBatch {
  ulid: string;
  source: BatchSource;
  store: string | null;
  purchased_at: Date;
}

export interface NewBatchLine {
  ulid: string;
  batch_ulid: string;
  raw_text: string;
  /** Physical-unit count the line represents (≥ 1; default 1 when omitted). */
  quantity?: number;
  /** Printed extended price in integer cents (§ Prices); null/omitted = unreadable. */
  price_cents?: number | null;
  match_outcome: LineMatchOutcome;
  product_ulid: string | null;
  inventory_item_ulid: string | null;
}

export interface ItemListFilter {
  /** States to include; default ['stocked','open']. */
  states?: InventoryState[];
  limit?: number;
}

export interface InventoryStore {
  // Products
  insertProduct(product: NewProduct): Promise<ProductRecord>;
  /**
   * By ULID — deliberately does NOT filter archived rows. Items, lexicon lines,
   * and batch lines point at products by ULID and must keep resolving after a
   * duplicate is retired (§ Product corrections).
   */
  getProduct(ulid: string): Promise<ProductRecord | null>;
  updateProduct(ulid: string, patch: ProductPatch): Promise<ProductRecord | null>;
  /** Live products only — archived rows are off every listing and match path. */
  listProducts(filter: { q?: string; limit?: number }): Promise<ProductRecord[]>;
  /**
   * Live products whose name normalizes (case-folded, whitespace-collapsed,
   * trimmed) to `normalized` — the name key for the `POST /products` upsert and
   * the rename-collision guard. Oldest first, so a caller reporting candidates
   * lists them in creation order.
   */
  findLiveProductsByNormalizedName(normalized: string): Promise<ProductRecord[]>;
  /**
   * Stamp `archived_at` (and `merged_into` when the retirement was a merge).
   * Idempotent — re-archiving keeps the original stamp. Null for an unknown
   * ULID. Never deletes a row (§ Product corrections).
   */
  archiveProduct(ulid: string, mergedInto?: string | null): Promise<ProductRecord | null>;
  /**
   * Repoint every dependent reference from one product to another — inventory
   * items, receipt-lexicon lines, and purchase batch lines — returning per-table
   * counts. The relink half of a merge.
   */
  relinkProductReferences(fromUlid: string, toUlid: string): Promise<ProductRelinkCounts>;
  getProductsByUlids(ulids: string[]): Promise<Map<string, ProductRecord>>;

  // Lexicon
  upsertLexicon(lexicon: NewLexicon): Promise<LexiconRecord>;
  getLexicon(store: string, lineText: string): Promise<LexiconRecord | null>;
  listLexicon(filter: { store?: string; limit?: number }): Promise<LexiconRecord[]>;

  // Items
  insertItemIfAbsent(item: NewItem): Promise<{ record: InventoryItemRecord; created: boolean }>;
  getItem(ulid: string): Promise<InventoryItemRecord | null>;
  listItems(filter: ItemListFilter): Promise<InventoryItemRecord[]>;
  listNeedsInfo(limit: number): Promise<InventoryItemRecord[]>;
  updateItemState(ulid: string, update: ItemStateUpdate): Promise<InventoryItemRecord | null>;
  setItemFraction(ulid: string, fraction: number): Promise<InventoryItemRecord | null>;
  resolveNeedsInfo(ulid: string, resolution: ResolveNeedsInfo): Promise<InventoryItemRecord | null>;
  /**
   * Write the identity fields an item merge fills on the survivor
   * (§ Item corrections). Only the supplied keys change; the caller has already
   * decided which of them are gaps, so this method does no null-guarding of its
   * own. An empty patch is a no-op returning the current row.
   */
  updateItemIdentity(ulid: string, patch: ItemIdentityPatch): Promise<InventoryItemRecord | null>;
  /**
   * Repoint every dependent reference from one item to another — consumption
   * entries are NOT included (they live in the phase-1 `EntryStore`; the
   * pipeline relinks them through an injected hook, the same seam the depletion
   * matcher's `linkEntry` uses). The relink half of an item merge.
   */
  relinkItemReferences(fromUlid: string, toUlid: string): Promise<Omit<ItemRelinkCounts, 'entries'>>;
  /**
   * Retire an item as the loser of a merge: terminal `dismissed`, `closed_at`
   * stamped, `merged_into` set. Idempotent — a replay keeps the first stamp and
   * the first survivor rather than sliding either forward. Applied from ANY
   * prior state, including a terminal one (§ Item corrections — the merge is the
   * assertion that this row was never independent stock, so a `finished` or
   * `tossed` on it is a claim about food that does not exist). Null for an
   * unknown ULID; never deletes a row.
   */
  retireMergedItem(ulid: string, mergedInto: string, at: Date): Promise<InventoryItemRecord | null>;

  // Batches
  insertBatchIfAbsent(batch: NewBatch): Promise<{ record: PurchaseBatchRecord; created: boolean }>;
  getBatch(ulid: string): Promise<PurchaseBatchRecord | null>;
  listBatches(limit: number): Promise<PurchaseBatchRecord[]>;
  selectBatchesForParsing(limit: number, maxAttempts: number): Promise<PurchaseBatchRecord[]>;
  setBatchStatus(ulid: string, status: BatchStatus): Promise<void>;
  /**
   * Persist the store resolved during a parse (meta store or header
   * extraction) plus whether it was left undetermined. Called once per parse,
   * before the batch flips to `parsed`.
   */
  setBatchStoreResolution(ulid: string, store: string | null, storeUndetermined: boolean): Promise<void>;
  /** Persist the receipt's printed grand total (§ Prices) once the parse read it. */
  setBatchTotal(ulid: string, totalCents: number | null): Promise<void>;
  recordBatchParseFailure(ulid: string, error: string): Promise<number>;

  // Batch lines
  insertLine(line: NewBatchLine): Promise<BatchLineRecord>;
  listLines(batchUlid: string): Promise<BatchLineRecord[]>;

  // Derivations (conversion provenance — § Conversions)
  insertDerivation(derivation: NewDerivation): Promise<InventoryDerivationRecord>;
  getDerivationsByDerivedItemUlids(ulids: string[]): Promise<Map<string, InventoryDerivationRecord>>;

  /**
   * Apply one conversion's every write as ONE atomic unit (§ Conversions §
   * Atomicity): each source's decrement, the derived item's insert, and the
   * derivation's insert. A failure at any point leaves NONE of them applied —
   * never sources spent with no derived item (food deleted from the ledger in
   * the direction nothing downstream flags), never a derived item with no
   * provenance (which would break cost attribution and cross-transform
   * eat-first reasoning).
   *
   * Deliberately ONE store method rather than the service composing
   * `updateItemState` × N + `insertItemIfAbsent` + `insertDerivation`, for the
   * same reason `ConsumeStore.consume` exists (services/consume-store.ts): a
   * transaction cannot be composed out of separate store calls. Unlike
   * `consume`, every table a conversion touches (`kitchen.inventory_items`,
   * `kitchen.inventory_derivations`) is owned by THIS store, so no store seam
   * is crossed and the transaction needs no second interface — the memory
   * implementation is the same mirror of this one every other method has.
   */
  applyConversion(write: ConversionWrite): Promise<ConversionWriteResult>;
}

// ── Helpers (shared with memory store via export) ─────────────────────────────

export const DEFAULT_ON_HAND_ITEM_STATES: readonly InventoryState[] = ['stocked', 'open'];

export function parseJsonField<T>(value: T | string | null): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function parseNumeric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const parsed = parseFloat(value as string);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(value as string);
}

function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return toDate(value);
}

export function rowToProduct(row: Record<string, unknown>): ProductRecord {
  return {
    ulid: row.ulid as string,
    name: row.name as string,
    shelf_life_class: row.shelf_life_class as ShelfLifeClass,
    aliases: (row.aliases as string[] | null) ?? [],
    nutrition_per_100g: parseJsonField<NutritionPer100g>(
      row.nutrition_per_100g as NutritionPer100g | string | null
    ),
    serving_size_g: row.serving_size_g == null ? null : Number(row.serving_size_g),
    nutrition_per_serving: parseJsonField<NutritionPer100g>(
      row.nutrition_per_serving as NutritionPer100g | string | null
    ),
    servings_per_container: row.servings_per_container == null ? null : Number(row.servings_per_container),
    unit_model_hint: (row.unit_model_hint as 'counted' | 'fraction' | null) ?? null,
    net_content_g: row.net_content_g == null ? null : Number(row.net_content_g),
    net_content_ml: row.net_content_ml == null ? null : Number(row.net_content_ml),
    ingredients: (row.ingredients as string | null) ?? null,
    package_size: (row.package_size as string | null) ?? null,
    shelf_life_days_unopened: row.shelf_life_days_unopened == null ? null : Number(row.shelf_life_days_unopened),
    shelf_life_days_opened: row.shelf_life_days_opened == null ? null : Number(row.shelf_life_days_opened),
    nutrition_negligible: Boolean(row.nutrition_negligible),
    archived_at: toDateOrNull(row.archived_at),
    merged_into: (row.merged_into as string | null) ?? null,
    created_at: toDate(row.created_at),
    updated_at: toDate(row.updated_at),
  };
}

export function rowToLexicon(row: Record<string, unknown>): LexiconRecord {
  return {
    ulid: row.ulid as string,
    store: row.store as string,
    line_text: row.line_text as string,
    product_ulid: (row.product_ulid as string | null) ?? null,
    package_size: (row.package_size as string | null) ?? null,
    shelf_life_class: (row.shelf_life_class as ShelfLifeClass | null) ?? null,
    non_inventory: Boolean(row.non_inventory),
    created_at: toDate(row.created_at),
    updated_at: toDate(row.updated_at),
  };
}

export function rowToItem(row: Record<string, unknown>): InventoryItemRecord {
  return {
    ulid: row.ulid as string,
    product_ulid: (row.product_ulid as string | null) ?? null,
    raw_label: (row.raw_label as string | null) ?? null,
    store: (row.store as string | null) ?? null,
    batch_ulid: (row.batch_ulid as string | null) ?? null,
    state: row.state as InventoryState,
    on_hand_fraction: parseNumeric(row.on_hand_fraction) ?? 0,
    units_total: row.units_total == null ? null : Number(row.units_total),
    units_remaining: row.units_remaining == null ? null : Number(row.units_remaining),
    unit_seal: (row.unit_seal as UnitSeal | null) ?? null,
    needs_info: Boolean(row.needs_info),
    acquired_at: toDate(row.acquired_at),
    opened_at: toDateOrNull(row.opened_at),
    closed_at: toDateOrNull(row.closed_at),
    storage_moved_at: toDateOrNull(row.storage_moved_at),
    eat_by: toDateOrNull(row.eat_by),
    shelf_life_class: (row.shelf_life_class as ShelfLifeClass | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    merged_into: (row.merged_into as string | null) ?? null,
    created_at: toDate(row.created_at),
    updated_at: toDate(row.updated_at),
  };
}

/**
 * The reference definition of what an `ItemStateUpdate` does to an item record:
 * `state` always lands, every other field is a present-means-replace patch.
 * `MemoryInventoryStore.updateItemState` merges through this directly, and the
 * conversion planner uses it to PROJECT a source's post-decrement state without
 * writing it (`InventoryPipeline.convert` has to plan a second decrement against
 * the first one's result). `PgInventoryStore`'s UPDATE necessarily restates the
 * same merge in SQL, column for column — keep the two in step.
 * Pure: returns a new record, mutates nothing.
 */
export function applyItemStateUpdate(
  current: InventoryItemRecord,
  update: ItemStateUpdate
): InventoryItemRecord {
  return {
    ...current,
    state: update.state,
    opened_at: update.opened_at !== undefined ? update.opened_at : current.opened_at,
    closed_at: update.closed_at !== undefined ? update.closed_at : current.closed_at,
    storage_moved_at: update.storage_moved_at !== undefined ? update.storage_moved_at : current.storage_moved_at,
    on_hand_fraction: update.on_hand_fraction !== undefined ? update.on_hand_fraction : current.on_hand_fraction,
    units_remaining: update.units_remaining !== undefined ? update.units_remaining : current.units_remaining,
    units_total: update.units_total !== undefined ? update.units_total : current.units_total,
    unit_seal: update.unit_seal !== undefined ? update.unit_seal : current.unit_seal,
    shelf_life_class: update.shelf_life_class !== undefined ? update.shelf_life_class : current.shelf_life_class,
    needs_info: update.needs_info !== undefined ? update.needs_info : current.needs_info,
    product_ulid: update.product_ulid !== undefined ? update.product_ulid : current.product_ulid,
    eat_by: update.eat_by !== undefined ? update.eat_by : current.eat_by,
    notes: update.notes !== undefined ? update.notes : current.notes,
    updated_at: new Date(),
  };
}

export function rowToBatch(row: Record<string, unknown>): PurchaseBatchRecord {
  return {
    ulid: row.ulid as string,
    source: row.source as BatchSource,
    store: (row.store as string | null) ?? null,
    store_undetermined: Boolean(row.store_undetermined),
    purchased_at: toDate(row.purchased_at),
    status: row.status as BatchStatus,
    parse_attempts: Number(row.parse_attempts ?? 0),
    last_error: (row.last_error as string | null) ?? null,
    last_error_at: toDateOrNull(row.last_error_at),
    total_cents: row.total_cents == null ? null : Number(row.total_cents),
    created_at: toDate(row.created_at),
    updated_at: toDate(row.updated_at),
  };
}

export function rowToLine(row: Record<string, unknown>): BatchLineRecord {
  return {
    ulid: row.ulid as string,
    batch_ulid: row.batch_ulid as string,
    raw_text: row.raw_text as string,
    quantity: row.quantity == null ? 1 : Number(row.quantity),
    price_cents: row.price_cents == null ? null : Number(row.price_cents),
    match_outcome: row.match_outcome as LineMatchOutcome,
    product_ulid: (row.product_ulid as string | null) ?? null,
    inventory_item_ulid: (row.inventory_item_ulid as string | null) ?? null,
    created_at: toDate(row.created_at),
  };
}

export function rowToDerivation(row: Record<string, unknown>): InventoryDerivationRecord {
  return {
    ulid: row.ulid as string,
    derived_item_ulid: row.derived_item_ulid as string,
    sources: parseJsonField<DerivationSource[]>(row.sources as DerivationSource[] | string | null) ?? [],
    recipe_ulid: (row.recipe_ulid as string | null) ?? null,
    created_at: toDate(row.created_at),
  };
}

// ── Postgres implementation ───────────────────────────────────────────────────

export class PgInventoryStore implements InventoryStore {
  constructor(private sql: postgres.Sql) {}

  async insertProduct(product: NewProduct): Promise<ProductRecord> {
    // NB `sql.json()`: porsager/postgres sends a plain JS string bound to a
    // jsonb column as a jsonb STRING SCALAR (double-encoded) — and an
    // explicit `::jsonb` cast does NOT fix it (jsonb→jsonb is a no-op; the
    // 2026-07-23 recurrence proved it empirically). sql.json() is the only
    // correct way to bind an object. Migrations 009/012 repaired historical
    // rows.
    const [row] = await this.sql`
      INSERT INTO kitchen.products
        (ulid, name, shelf_life_class, aliases, nutrition_per_100g,
         serving_size_g, nutrition_per_serving, servings_per_container,
         unit_model_hint, net_content_g, net_content_ml, ingredients,
         package_size, shelf_life_days_unopened, shelf_life_days_opened,
         nutrition_negligible)
      VALUES (
        ${product.ulid}, ${product.name}, ${product.shelf_life_class},
        ${product.aliases}, ${product.nutrition_per_100g ? this.sql.json(product.nutrition_per_100g as never) : null},
        ${product.serving_size_g ?? null},
        ${product.nutrition_per_serving ? this.sql.json(product.nutrition_per_serving as never) : null},
        ${product.servings_per_container ?? null},
        ${product.unit_model_hint ?? null}, ${product.net_content_g ?? null},
        ${product.net_content_ml ?? null}, ${product.ingredients}, ${product.package_size},
        ${product.shelf_life_days_unopened}, ${product.shelf_life_days_opened},
        ${product.nutrition_negligible ?? false}
      )
      RETURNING *
    `;
    return rowToProduct(row!);
  }

  async getProduct(ulid: string): Promise<ProductRecord | null> {
    const [row] = await this.sql`SELECT * FROM kitchen.products WHERE ulid = ${ulid}`;
    return row ? rowToProduct(row) : null;
  }

  async updateProduct(ulid: string, patch: ProductPatch): Promise<ProductRecord | null> {
    const current = await this.getProduct(ulid);
    if (!current) return null;
    const merged = { ...current, ...patch };
    const [row] = await this.sql`
      UPDATE kitchen.products SET
        name = ${merged.name},
        shelf_life_class = ${merged.shelf_life_class},
        aliases = ${merged.aliases},
        nutrition_per_100g = ${merged.nutrition_per_100g ? this.sql.json(merged.nutrition_per_100g as never) : null},
        serving_size_g = ${merged.serving_size_g ?? null},
        nutrition_per_serving = ${merged.nutrition_per_serving ? this.sql.json(merged.nutrition_per_serving as never) : null},
        servings_per_container = ${merged.servings_per_container ?? null},
        unit_model_hint = ${merged.unit_model_hint ?? null},
        net_content_g = ${merged.net_content_g ?? null},
        net_content_ml = ${merged.net_content_ml ?? null},
        ingredients = ${merged.ingredients},
        package_size = ${merged.package_size},
        shelf_life_days_unopened = ${merged.shelf_life_days_unopened},
        shelf_life_days_opened = ${merged.shelf_life_days_opened},
        nutrition_negligible = ${merged.nutrition_negligible}
      WHERE ulid = ${ulid}
      RETURNING *
    `;
    return row ? rowToProduct(row) : null;
  }

  async listProducts(filter: { q?: string; limit?: number }): Promise<ProductRecord[]> {
    const limit = Math.min(filter.limit ?? 100, 500);
    const rows = filter.q
      ? await this.sql`
          SELECT * FROM kitchen.products
          WHERE archived_at IS NULL
            AND (name ILIKE ${'%' + filter.q + '%'}
             OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE ${'%' + filter.q + '%'}))
          ORDER BY name ASC LIMIT ${limit}
        `
      : await this.sql`
          SELECT * FROM kitchen.products
          WHERE archived_at IS NULL
          ORDER BY name ASC LIMIT ${limit}
        `;
    return rows.map(rowToProduct);
  }

  async findLiveProductsByNormalizedName(normalized: string): Promise<ProductRecord[]> {
    const rows = await this.sql`
      SELECT * FROM kitchen.products
      WHERE archived_at IS NULL
        AND lower(btrim(regexp_replace(name, '\\s+', ' ', 'g'))) = ${normalized}
      ORDER BY created_at ASC
    `;
    return rows.map(rowToProduct);
  }

  async archiveProduct(ulid: string, mergedInto: string | null = null): Promise<ProductRecord | null> {
    // COALESCE keeps the first retirement's stamp so a re-archive is idempotent
    // rather than sliding the date forward on every replay.
    const [row] = await this.sql`
      UPDATE kitchen.products
      SET archived_at = COALESCE(archived_at, NOW()),
          merged_into = COALESCE(merged_into, ${mergedInto})
      WHERE ulid = ${ulid}
      RETURNING *
    `;
    return row ? rowToProduct(row) : null;
  }

  async relinkProductReferences(fromUlid: string, toUlid: string): Promise<ProductRelinkCounts> {
    const items = await this.sql`
      UPDATE kitchen.inventory_items SET product_ulid = ${toUlid}
      WHERE product_ulid = ${fromUlid} RETURNING ulid
    `;
    const lexicon = await this.sql`
      UPDATE kitchen.receipt_lexicon SET product_ulid = ${toUlid}
      WHERE product_ulid = ${fromUlid} RETURNING ulid
    `;
    const lines = await this.sql`
      UPDATE kitchen.purchase_batch_lines SET product_ulid = ${toUlid}
      WHERE product_ulid = ${fromUlid} RETURNING ulid
    `;
    return { items: items.length, lexicon_lines: lexicon.length, batch_lines: lines.length };
  }

  async getProductsByUlids(ulids: string[]): Promise<Map<string, ProductRecord>> {
    const map = new Map<string, ProductRecord>();
    if (ulids.length === 0) return map;
    const rows = await this.sql`SELECT * FROM kitchen.products WHERE ulid IN ${this.sql(ulids)}`;
    for (const row of rows) {
      const p = rowToProduct(row);
      map.set(p.ulid, p);
    }
    return map;
  }

  async upsertLexicon(lexicon: NewLexicon): Promise<LexiconRecord> {
    const [row] = await this.sql`
      INSERT INTO kitchen.receipt_lexicon
        (ulid, store, line_text, product_ulid, package_size, shelf_life_class, non_inventory)
      VALUES (
        ${lexicon.ulid}, ${lexicon.store}, ${lexicon.line_text}, ${lexicon.product_ulid},
        ${lexicon.package_size}, ${lexicon.shelf_life_class}, ${lexicon.non_inventory ?? false}
      )
      ON CONFLICT (store, line_text) DO UPDATE SET
        product_ulid = EXCLUDED.product_ulid,
        package_size = EXCLUDED.package_size,
        shelf_life_class = EXCLUDED.shelf_life_class,
        non_inventory = EXCLUDED.non_inventory
      RETURNING *
    `;
    const record = rowToLexicon(row!);
    // claude-assist#102: a product mapping retro-resolves pending needs_info
    // items carrying the same (store, line_text) — see § Receipt lexicon
    // (specs/modules/kitchen.md). A skip marker (null product_ulid) has
    // nothing to attach, so it's a no-op here.
    if (record.product_ulid) {
      await this.retroResolveLexiconMatches(record);
    }
    return record;
  }

  /**
   * Resolve every open (`stocked`/`open`) `needs_info` item sharing this
   * lexicon line's `(store, normalized raw_label)` — the same attach +
   * clear-needs_info + re-derive-eat_by resolution `resolveLabel`'s fan-out
   * applies to same-batch siblings, triggered here from the lexicon-upsert
   * side instead of a scanned item. Each item's `eat_by` is re-derived from
   * its OWN acquired/opened clock — distinct physical units.
   */
  private async retroResolveLexiconMatches(lexicon: LexiconRecord): Promise<void> {
    if (!lexicon.product_ulid) return;
    const product = await this.getProduct(lexicon.product_ulid);
    const rows = await this.sql`
      SELECT * FROM kitchen.inventory_items
      WHERE needs_info = TRUE AND state IN ('stocked', 'open')
        AND store = ${lexicon.store} AND raw_label IS NOT NULL
    `;
    for (const row of rows) {
      const item = rowToItem(row);
      if (normalizeLexiconLine(item.raw_label!) !== lexicon.line_text) continue;
      const cls = lexicon.shelf_life_class ?? product?.shelf_life_class ?? 'unknown';
      const eatBy = deriveEatBy({
        shelfLifeClass: cls,
        acquiredAt: item.acquired_at,
        openedAt: item.opened_at,
        daysUnopenedOverride: product?.shelf_life_days_unopened,
        daysOpenedOverride: product?.shelf_life_days_opened,
      });
      await this.resolveNeedsInfo(item.ulid, { product_ulid: lexicon.product_ulid, shelf_life_class: cls, eat_by: eatBy });
    }
  }

  async getLexicon(store: string, lineText: string): Promise<LexiconRecord | null> {
    const [row] = await this.sql`
      SELECT * FROM kitchen.receipt_lexicon WHERE store = ${store} AND line_text = ${lineText}
    `;
    return row ? rowToLexicon(row) : null;
  }

  async listLexicon(filter: { store?: string; limit?: number }): Promise<LexiconRecord[]> {
    const limit = Math.min(filter.limit ?? 200, 1000);
    const rows = filter.store
      ? await this.sql`
          SELECT * FROM kitchen.receipt_lexicon WHERE store = ${filter.store}
          ORDER BY line_text ASC LIMIT ${limit}
        `
      : await this.sql`SELECT * FROM kitchen.receipt_lexicon ORDER BY store, line_text ASC LIMIT ${limit}`;
    return rows.map(rowToLexicon);
  }

  // The item/derivation writes a conversion needs are parameterized on their
  // `sql` handle rather than reaching for `this.sql`, so `applyConversion` can
  // re-issue the SAME statements against a transaction handle instead of
  // duplicating them (the drift `PgConsumeStore`'s inline copies risk).

  private async insertItemIfAbsentWith(
    sql: postgres.Sql,
    item: NewItem
  ): Promise<{ record: InventoryItemRecord; created: boolean }> {
    const inserted = await sql`
      INSERT INTO kitchen.inventory_items
        (ulid, product_ulid, raw_label, store, batch_ulid, state, on_hand_fraction,
         units_total, units_remaining, unit_seal, needs_info, acquired_at, eat_by,
         shelf_life_class, notes)
      VALUES (
        ${item.ulid}, ${item.product_ulid}, ${item.raw_label}, ${item.store}, ${item.batch_ulid},
        ${item.state}, ${item.on_hand_fraction}, ${item.units_total ?? null}, ${item.units_remaining ?? null},
        ${item.unit_seal ?? null},
        ${item.needs_info}, ${item.acquired_at}, ${item.eat_by}, ${item.shelf_life_class}, ${item.notes}
      )
      ON CONFLICT (ulid) DO NOTHING
      RETURNING *
    `;
    if (inserted.length > 0) return { record: rowToItem(inserted[0]!), created: true };
    const existing = await this.getItemWith(sql, item.ulid);
    if (!existing) throw new Error(`Inventory item ${item.ulid} conflicted on insert but is not readable`);
    return { record: existing, created: false };
  }

  private async getItemWith(sql: postgres.Sql, ulid: string): Promise<InventoryItemRecord | null> {
    const [row] = await sql`SELECT * FROM kitchen.inventory_items WHERE ulid = ${ulid}`;
    return row ? rowToItem(row) : null;
  }

  private async updateItemStateWith(
    sql: postgres.Sql,
    ulid: string,
    update: ItemStateUpdate
  ): Promise<InventoryItemRecord | null> {
    const current = await this.getItemWith(sql, ulid);
    if (!current) return null;
    const [row] = await sql`
      UPDATE kitchen.inventory_items SET
        state = ${update.state},
        opened_at = ${update.opened_at !== undefined ? update.opened_at : current.opened_at},
        closed_at = ${update.closed_at !== undefined ? update.closed_at : current.closed_at},
        storage_moved_at = ${update.storage_moved_at !== undefined ? update.storage_moved_at : current.storage_moved_at},
        on_hand_fraction = ${update.on_hand_fraction ?? current.on_hand_fraction},
        units_remaining = ${update.units_remaining !== undefined ? update.units_remaining : current.units_remaining},
        units_total = ${update.units_total !== undefined ? update.units_total : current.units_total},
        unit_seal = ${update.unit_seal !== undefined ? update.unit_seal : current.unit_seal},
        shelf_life_class = ${update.shelf_life_class !== undefined ? update.shelf_life_class : current.shelf_life_class},
        needs_info = ${update.needs_info !== undefined ? update.needs_info : current.needs_info},
        product_ulid = ${update.product_ulid !== undefined ? update.product_ulid : current.product_ulid},
        eat_by = ${update.eat_by !== undefined ? update.eat_by : current.eat_by},
        notes = ${update.notes !== undefined ? update.notes : current.notes}
      WHERE ulid = ${ulid}
      RETURNING *
    `;
    return row ? rowToItem(row) : null;
  }

  private async insertDerivationWith(
    sql: postgres.Sql,
    derivation: NewDerivation
  ): Promise<InventoryDerivationRecord> {
    const [row] = await sql`
      INSERT INTO kitchen.inventory_derivations (ulid, derived_item_ulid, sources, recipe_ulid)
      VALUES (
        ${derivation.ulid}, ${derivation.derived_item_ulid}, ${sql.json(derivation.sources as never)},
        ${derivation.recipe_ulid}
      )
      RETURNING *
    `;
    return rowToDerivation(row!);
  }

  async insertItemIfAbsent(item: NewItem): Promise<{ record: InventoryItemRecord; created: boolean }> {
    return this.insertItemIfAbsentWith(this.sql, item);
  }

  async getItem(ulid: string): Promise<InventoryItemRecord | null> {
    return this.getItemWith(this.sql, ulid);
  }

  async listItems(filter: ItemListFilter): Promise<InventoryItemRecord[]> {
    const states = filter.states ?? [...DEFAULT_ON_HAND_ITEM_STATES];
    const limit = Math.min(filter.limit ?? 100, 500);
    const rows = await this.sql`
      SELECT * FROM kitchen.inventory_items
      WHERE state IN ${this.sql(states)}
      ORDER BY eat_by ASC NULLS LAST, acquired_at ASC
      LIMIT ${limit}
    `;
    return rows.map(rowToItem);
  }

  async listNeedsInfo(limit: number): Promise<InventoryItemRecord[]> {
    const rows = await this.sql`
      SELECT * FROM kitchen.inventory_items
      WHERE needs_info = TRUE AND state IN ('stocked', 'open')
      ORDER BY acquired_at ASC
      LIMIT ${Math.min(limit, 500)}
    `;
    return rows.map(rowToItem);
  }

  async updateItemState(ulid: string, update: ItemStateUpdate): Promise<InventoryItemRecord | null> {
    return this.updateItemStateWith(this.sql, ulid, update);
  }

  async setItemFraction(ulid: string, fraction: number): Promise<InventoryItemRecord | null> {
    const [row] = await this.sql`
      UPDATE kitchen.inventory_items SET on_hand_fraction = ${fraction}
      WHERE ulid = ${ulid} RETURNING *
    `;
    return row ? rowToItem(row) : null;
  }

  async resolveNeedsInfo(ulid: string, resolution: ResolveNeedsInfo): Promise<InventoryItemRecord | null> {
    const [row] = await this.sql`
      UPDATE kitchen.inventory_items SET
        product_ulid = ${resolution.product_ulid},
        shelf_life_class = ${resolution.shelf_life_class},
        eat_by = ${resolution.eat_by},
        needs_info = FALSE
      WHERE ulid = ${ulid}
      RETURNING *
    `;
    return row ? rowToItem(row) : null;
  }

  async updateItemIdentity(ulid: string, patch: ItemIdentityPatch): Promise<InventoryItemRecord | null> {
    const current = await this.getItem(ulid);
    if (!current) return null;
    // Read-merge-write over the five identity columns, mirroring updateProduct's
    // shape rather than building a dynamic SET clause.
    const merged = { ...current, ...patch };
    const [row] = await this.sql`
      UPDATE kitchen.inventory_items SET
        product_ulid = ${merged.product_ulid},
        raw_label = ${merged.raw_label},
        store = ${merged.store},
        batch_ulid = ${merged.batch_ulid},
        shelf_life_class = ${merged.shelf_life_class}
      WHERE ulid = ${ulid}
      RETURNING *
    `;
    return row ? rowToItem(row) : null;
  }

  async relinkItemReferences(
    fromUlid: string,
    toUlid: string
  ): Promise<Omit<ItemRelinkCounts, 'entries'>> {
    const lines = await this.sql`
      UPDATE kitchen.purchase_batch_lines SET inventory_item_ulid = ${toUlid}
      WHERE inventory_item_ulid = ${fromUlid} RETURNING ulid
    `;
    // derived_item_ulid is UNIQUE (1:1 — a derived item is made by exactly one
    // conversion), so the loser's provenance can only move onto a survivor that
    // has none. When the survivor already carries its own, the loser's stays put:
    // dropping one to satisfy the constraint would destroy provenance.
    const derivations = await this.sql`
      UPDATE kitchen.inventory_derivations SET derived_item_ulid = ${toUlid}
      WHERE derived_item_ulid = ${fromUlid}
        AND NOT EXISTS (
          SELECT 1 FROM kitchen.inventory_derivations d2 WHERE d2.derived_item_ulid = ${toUlid}
        )
      RETURNING ulid
    `;
    // The loser as a conversion INPUT: sources is [{item_ulid, amount,
    // amount_kind}], so the ulid is rewritten inside the array, element-wise.
    const sources = await this.sql`
      UPDATE kitchen.inventory_derivations d SET sources = (
        SELECT COALESCE(jsonb_agg(
          CASE WHEN e->>'item_ulid' = ${fromUlid}
            THEN jsonb_set(e, '{item_ulid}', to_jsonb(${toUlid}::text))
            ELSE e
          END
          ORDER BY ord
        ), '[]'::jsonb)
        FROM jsonb_array_elements(d.sources) WITH ORDINALITY AS t(e, ord)
      )
      WHERE d.sources @> jsonb_build_array(jsonb_build_object('item_ulid', ${fromUlid}::text))
      RETURNING ulid
    `;
    return {
      batch_lines: lines.length,
      derivations: derivations.length,
      derivation_sources: sources.length,
    };
  }

  async retireMergedItem(ulid: string, mergedInto: string, at: Date): Promise<InventoryItemRecord | null> {
    // COALESCE on both stamps: a replayed merge must not slide closed_at forward
    // or repoint an item that already went somewhere (the service refuses the
    // cross-target case before reaching here).
    const [row] = await this.sql`
      UPDATE kitchen.inventory_items SET
        state = 'dismissed',
        closed_at = COALESCE(closed_at, ${at}),
        merged_into = COALESCE(merged_into, ${mergedInto})
      WHERE ulid = ${ulid}
      RETURNING *
    `;
    return row ? rowToItem(row) : null;
  }

  async insertBatchIfAbsent(batch: NewBatch): Promise<{ record: PurchaseBatchRecord; created: boolean }> {
    const inserted = await this.sql`
      INSERT INTO kitchen.purchase_batches (ulid, source, store, purchased_at, status)
      VALUES (${batch.ulid}, ${batch.source}, ${batch.store}, ${batch.purchased_at}, 'parsing')
      ON CONFLICT (ulid) DO NOTHING
      RETURNING *
    `;
    if (inserted.length > 0) return { record: rowToBatch(inserted[0]!), created: true };
    const existing = await this.getBatch(batch.ulid);
    if (!existing) throw new Error(`Purchase batch ${batch.ulid} conflicted on insert but is not readable`);
    return { record: existing, created: false };
  }

  async getBatch(ulid: string): Promise<PurchaseBatchRecord | null> {
    const [row] = await this.sql`SELECT * FROM kitchen.purchase_batches WHERE ulid = ${ulid}`;
    return row ? rowToBatch(row) : null;
  }

  async listBatches(limit: number): Promise<PurchaseBatchRecord[]> {
    const rows = await this.sql`
      SELECT * FROM kitchen.purchase_batches ORDER BY purchased_at DESC, created_at DESC
      LIMIT ${Math.min(limit, 500)}
    `;
    return rows.map(rowToBatch);
  }

  async selectBatchesForParsing(limit: number, maxAttempts: number): Promise<PurchaseBatchRecord[]> {
    const rows = await this.sql`
      SELECT * FROM kitchen.purchase_batches
      WHERE status = 'parsing' AND parse_attempts < ${maxAttempts}
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
    return rows.map(rowToBatch);
  }

  async setBatchStatus(ulid: string, status: BatchStatus): Promise<void> {
    await this.sql`UPDATE kitchen.purchase_batches SET status = ${status} WHERE ulid = ${ulid}`;
  }

  async setBatchStoreResolution(
    ulid: string,
    store: string | null,
    storeUndetermined: boolean
  ): Promise<void> {
    await this.sql`
      UPDATE kitchen.purchase_batches
      SET store = ${store}, store_undetermined = ${storeUndetermined}
      WHERE ulid = ${ulid}
    `;
  }

  async setBatchTotal(ulid: string, totalCents: number | null): Promise<void> {
    await this.sql`
      UPDATE kitchen.purchase_batches SET total_cents = ${totalCents} WHERE ulid = ${ulid}
    `;
  }

  async recordBatchParseFailure(ulid: string, error: string): Promise<number> {
    const [row] = await this.sql<{ parse_attempts: number }[]>`
      UPDATE kitchen.purchase_batches SET
        parse_attempts = parse_attempts + 1, last_error = ${error}, last_error_at = NOW()
      WHERE ulid = ${ulid}
      RETURNING parse_attempts
    `;
    return row?.parse_attempts ?? 0;
  }

  async insertLine(line: NewBatchLine): Promise<BatchLineRecord> {
    const [row] = await this.sql`
      INSERT INTO kitchen.purchase_batch_lines
        (ulid, batch_ulid, raw_text, quantity, price_cents, match_outcome, product_ulid, inventory_item_ulid)
      VALUES (
        ${line.ulid}, ${line.batch_ulid}, ${line.raw_text}, ${line.quantity ?? 1},
        ${line.price_cents ?? null},
        ${line.match_outcome}, ${line.product_ulid}, ${line.inventory_item_ulid}
      )
      RETURNING *
    `;
    return rowToLine(row!);
  }

  async listLines(batchUlid: string): Promise<BatchLineRecord[]> {
    const rows = await this.sql`
      SELECT * FROM kitchen.purchase_batch_lines WHERE batch_ulid = ${batchUlid}
      ORDER BY created_at ASC
    `;
    return rows.map(rowToLine);
  }

  async insertDerivation(derivation: NewDerivation): Promise<InventoryDerivationRecord> {
    return this.insertDerivationWith(this.sql, derivation);
  }

  async applyConversion(write: ConversionWrite): Promise<ConversionWriteResult> {
    return this.sql.begin(async (rawTx) => {
      // postgres.js's TransactionSql type drops the tagged-template call
      // signature (a TS/Omit limitation) even though it's present at runtime —
      // same cast services/consume-store.ts and packages/pages/src/store.ts use
      // for their own `sql.begin` transactions.
      const tx = rawTx as unknown as postgres.Sql;

      const sources: InventoryItemRecord[] = [];
      for (const source of write.sources) {
        const updated = await this.updateItemStateWith(tx, source.item_ulid, source.update);
        if (!updated) {
          // Validated as present before the transaction opened, so this is a
          // concurrent delete — abort and roll every sibling decrement back
          // rather than proceed with a source that isn't there.
          throw new Error(`applyConversion: source item ${source.item_ulid} not found mid-transaction`);
        }
        sources.push(updated);
      }

      const { record: derived } = await this.insertItemIfAbsentWith(tx, write.derived);
      const derivation = await this.insertDerivationWith(tx, write.derivation);

      return { sources, derived, derivation };
    });
  }

  async getDerivationsByDerivedItemUlids(ulids: string[]): Promise<Map<string, InventoryDerivationRecord>> {
    const map = new Map<string, InventoryDerivationRecord>();
    if (ulids.length === 0) return map;
    const rows = await this.sql`
      SELECT * FROM kitchen.inventory_derivations WHERE derived_item_ulid IN ${this.sql(ulids)}
    `;
    for (const row of rows) {
      const d = rowToDerivation(row);
      map.set(d.derived_item_ulid, d);
    }
    return map;
  }
}
