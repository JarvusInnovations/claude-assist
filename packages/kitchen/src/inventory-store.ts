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
  LexiconRecord,
  LineMatchOutcome,
  NutritionPer100g,
  ProductRecord,
  PurchaseBatchRecord,
  ShelfLifeClass,
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
  /** Sealed-unit count model (both null = fraction-modeled). See InventoryItemRecord. */
  units_total?: number | null;
  units_remaining?: number | null;
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
  getProduct(ulid: string): Promise<ProductRecord | null>;
  updateProduct(ulid: string, patch: ProductPatch): Promise<ProductRecord | null>;
  listProducts(filter: { q?: string; limit?: number }): Promise<ProductRecord[]>;
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
    needs_info: Boolean(row.needs_info),
    acquired_at: toDate(row.acquired_at),
    opened_at: toDateOrNull(row.opened_at),
    closed_at: toDateOrNull(row.closed_at),
    eat_by: toDateOrNull(row.eat_by),
    shelf_life_class: (row.shelf_life_class as ShelfLifeClass | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    created_at: toDate(row.created_at),
    updated_at: toDate(row.updated_at),
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
    // NB the ::jsonb casts: binding a JSON string without one stores a jsonb
    // *string scalar* (double-encoded), killing SQL-side inspection —
    // migration 009 repaired the historical rows.
    const [row] = await this.sql`
      INSERT INTO kitchen.products
        (ulid, name, shelf_life_class, aliases, nutrition_per_100g,
         serving_size_g, nutrition_per_serving, servings_per_container,
         unit_model_hint, net_content_g, net_content_ml, ingredients,
         package_size, shelf_life_days_unopened, shelf_life_days_opened)
      VALUES (
        ${product.ulid}, ${product.name}, ${product.shelf_life_class},
        ${product.aliases}, ${product.nutrition_per_100g ? JSON.stringify(product.nutrition_per_100g) : null}::jsonb,
        ${product.serving_size_g ?? null},
        ${product.nutrition_per_serving ? JSON.stringify(product.nutrition_per_serving) : null}::jsonb,
        ${product.servings_per_container ?? null},
        ${product.unit_model_hint ?? null}, ${product.net_content_g ?? null},
        ${product.net_content_ml ?? null}, ${product.ingredients}, ${product.package_size},
        ${product.shelf_life_days_unopened}, ${product.shelf_life_days_opened}
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
        nutrition_per_100g = ${merged.nutrition_per_100g ? JSON.stringify(merged.nutrition_per_100g) : null}::jsonb,
        serving_size_g = ${merged.serving_size_g ?? null},
        nutrition_per_serving = ${merged.nutrition_per_serving ? JSON.stringify(merged.nutrition_per_serving) : null}::jsonb,
        servings_per_container = ${merged.servings_per_container ?? null},
        unit_model_hint = ${merged.unit_model_hint ?? null},
        net_content_g = ${merged.net_content_g ?? null},
        net_content_ml = ${merged.net_content_ml ?? null},
        ingredients = ${merged.ingredients},
        package_size = ${merged.package_size},
        shelf_life_days_unopened = ${merged.shelf_life_days_unopened},
        shelf_life_days_opened = ${merged.shelf_life_days_opened}
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
          WHERE name ILIKE ${'%' + filter.q + '%'}
             OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE ${'%' + filter.q + '%'})
          ORDER BY name ASC LIMIT ${limit}
        `
      : await this.sql`SELECT * FROM kitchen.products ORDER BY name ASC LIMIT ${limit}`;
    return rows.map(rowToProduct);
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

  async insertItemIfAbsent(item: NewItem): Promise<{ record: InventoryItemRecord; created: boolean }> {
    const inserted = await this.sql`
      INSERT INTO kitchen.inventory_items
        (ulid, product_ulid, raw_label, store, batch_ulid, state, on_hand_fraction,
         units_total, units_remaining, needs_info, acquired_at, eat_by, shelf_life_class, notes)
      VALUES (
        ${item.ulid}, ${item.product_ulid}, ${item.raw_label}, ${item.store}, ${item.batch_ulid},
        ${item.state}, ${item.on_hand_fraction}, ${item.units_total ?? null}, ${item.units_remaining ?? null},
        ${item.needs_info}, ${item.acquired_at}, ${item.eat_by}, ${item.shelf_life_class}, ${item.notes}
      )
      ON CONFLICT (ulid) DO NOTHING
      RETURNING *
    `;
    if (inserted.length > 0) return { record: rowToItem(inserted[0]!), created: true };
    const existing = await this.getItem(item.ulid);
    if (!existing) throw new Error(`Inventory item ${item.ulid} conflicted on insert but is not readable`);
    return { record: existing, created: false };
  }

  async getItem(ulid: string): Promise<InventoryItemRecord | null> {
    const [row] = await this.sql`SELECT * FROM kitchen.inventory_items WHERE ulid = ${ulid}`;
    return row ? rowToItem(row) : null;
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
    const current = await this.getItem(ulid);
    if (!current) return null;
    const [row] = await this.sql`
      UPDATE kitchen.inventory_items SET
        state = ${update.state},
        opened_at = ${update.opened_at !== undefined ? update.opened_at : current.opened_at},
        closed_at = ${update.closed_at !== undefined ? update.closed_at : current.closed_at},
        on_hand_fraction = ${update.on_hand_fraction ?? current.on_hand_fraction},
        units_remaining = ${update.units_remaining !== undefined ? update.units_remaining : current.units_remaining},
        units_total = ${update.units_total !== undefined ? update.units_total : current.units_total},
        eat_by = ${update.eat_by !== undefined ? update.eat_by : current.eat_by},
        notes = ${update.notes !== undefined ? update.notes : current.notes}
      WHERE ulid = ${ulid}
      RETURNING *
    `;
    return row ? rowToItem(row) : null;
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
    const [row] = await this.sql`
      INSERT INTO kitchen.inventory_derivations (ulid, derived_item_ulid, sources, recipe_ulid)
      VALUES (
        ${derivation.ulid}, ${derivation.derived_item_ulid}, ${JSON.stringify(derivation.sources)}::jsonb,
        ${derivation.recipe_ulid}
      )
      RETURNING *
    `;
    return rowToDerivation(row!);
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
