/**
 * In-memory InventoryStore. Used by the test suite; mirrors PgInventoryStore
 * semantics exactly (see memory-store.ts for the sibling phase-1 pattern).
 */

import type {
  BatchLineRecord,
  BatchStatus,
  InventoryDerivationRecord,
  InventoryItemRecord,
  InventoryState,
  LexiconRecord,
  ProductRecord,
  PurchaseBatchRecord,
} from './inventory-types.js';
import type {
  InventoryStore,
  ItemListFilter,
  ItemStateUpdate,
  NewBatch,
  NewBatchLine,
  NewDerivation,
  NewItem,
  NewLexicon,
  NewProduct,
  ProductPatch,
  ResolveNeedsInfo,
} from './inventory-store.js';
import { DEFAULT_ON_HAND_ITEM_STATES } from './inventory-store.js';
import { deriveEatBy, normalizeLexiconLine } from './inventory-derive.js';

function nullsLastEatBy(a: InventoryItemRecord, b: InventoryItemRecord): number {
  const av = a.eat_by ? a.eat_by.getTime() : Number.POSITIVE_INFINITY;
  const bv = b.eat_by ? b.eat_by.getTime() : Number.POSITIVE_INFINITY;
  if (av !== bv) return av - bv;
  return a.acquired_at.getTime() - b.acquired_at.getTime();
}

export class MemoryInventoryStore implements InventoryStore {
  readonly products = new Map<string, ProductRecord>();
  readonly lexicon = new Map<string, LexiconRecord>(); // key: `${store}\x00${line_text}`
  readonly items = new Map<string, InventoryItemRecord>();
  readonly batches = new Map<string, PurchaseBatchRecord>();
  readonly lines = new Map<string, BatchLineRecord>();
  readonly derivations = new Map<string, InventoryDerivationRecord>(); // key: derived_item_ulid

  private lexKey(store: string, lineText: string): string {
    return `${store}\x00${lineText}`;
  }

  async insertProduct(product: NewProduct): Promise<ProductRecord> {
    const now = new Date();
    const record: ProductRecord = {
      ...product,
      serving_size_g: product.serving_size_g ?? null,
      nutrition_per_serving: product.nutrition_per_serving ?? null,
      servings_per_container: product.servings_per_container ?? null,
      unit_model_hint: product.unit_model_hint ?? null,
      created_at: now,
      updated_at: now,
    };
    this.products.set(product.ulid, record);
    return structuredClone(record);
  }

  async getProduct(ulid: string): Promise<ProductRecord | null> {
    const p = this.products.get(ulid);
    return p ? structuredClone(p) : null;
  }

  async updateProduct(ulid: string, patch: ProductPatch): Promise<ProductRecord | null> {
    const p = this.products.get(ulid);
    if (!p) return null;
    Object.assign(p, patch);
    p.updated_at = new Date();
    return structuredClone(p);
  }

  async listProducts(filter: { q?: string; limit?: number }): Promise<ProductRecord[]> {
    const limit = Math.min(filter.limit ?? 100, 500);
    const q = filter.q?.toLowerCase();
    return [...this.products.values()]
      .filter((p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.aliases.some((a) => a.toLowerCase().includes(q))
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((p) => structuredClone(p));
  }

  async getProductsByUlids(ulids: string[]): Promise<Map<string, ProductRecord>> {
    const map = new Map<string, ProductRecord>();
    for (const ulid of ulids) {
      const p = this.products.get(ulid);
      if (p) map.set(ulid, structuredClone(p));
    }
    return map;
  }

  async upsertLexicon(lexicon: NewLexicon): Promise<LexiconRecord> {
    const key = this.lexKey(lexicon.store, lexicon.line_text);
    const existing = this.lexicon.get(key);
    const now = new Date();
    let record: LexiconRecord;
    if (existing) {
      existing.product_ulid = lexicon.product_ulid;
      existing.package_size = lexicon.package_size;
      existing.shelf_life_class = lexicon.shelf_life_class;
      existing.non_inventory = lexicon.non_inventory ?? false;
      existing.updated_at = now;
      record = existing;
    } else {
      record = {
        ...lexicon,
        non_inventory: lexicon.non_inventory ?? false,
        created_at: now,
        updated_at: now,
      };
      this.lexicon.set(key, record);
    }
    // claude-assist#102: a product mapping retro-resolves pending needs_info
    // items carrying the same (store, line_text) — see § Receipt lexicon
    // (specs/modules/kitchen.md). A skip marker (null product_ulid) has
    // nothing to attach, so it's a no-op here.
    if (record.product_ulid) {
      await this.retroResolveLexiconMatches(record);
    }
    return structuredClone(record);
  }

  /**
   * Resolve every open (`stocked`/`open`) `needs_info` item sharing this
   * lexicon line's `(store, normalized raw_label)` — mirrors
   * PgInventoryStore's retroResolveLexiconMatches exactly (lockstep).
   */
  private async retroResolveLexiconMatches(lexicon: LexiconRecord): Promise<void> {
    if (!lexicon.product_ulid) return;
    const product = this.products.get(lexicon.product_ulid) ?? null;
    const matches = [...this.items.values()].filter(
      (i) =>
        i.needs_info &&
        (i.state === 'stocked' || i.state === 'open') &&
        i.store === lexicon.store &&
        i.raw_label != null &&
        normalizeLexiconLine(i.raw_label) === lexicon.line_text
    );
    for (const item of matches) {
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
    const rec = this.lexicon.get(this.lexKey(store, lineText));
    return rec ? structuredClone(rec) : null;
  }

  async listLexicon(filter: { store?: string; limit?: number }): Promise<LexiconRecord[]> {
    const limit = Math.min(filter.limit ?? 200, 1000);
    return [...this.lexicon.values()]
      .filter((l) => !filter.store || l.store === filter.store)
      .sort((a, b) => a.store.localeCompare(b.store) || a.line_text.localeCompare(b.line_text))
      .slice(0, limit)
      .map((l) => structuredClone(l));
  }

  async insertItemIfAbsent(item: NewItem): Promise<{ record: InventoryItemRecord; created: boolean }> {
    const existing = this.items.get(item.ulid);
    if (existing) return { record: structuredClone(existing), created: false };
    const now = new Date();
    const record: InventoryItemRecord = {
      ulid: item.ulid,
      product_ulid: item.product_ulid,
      raw_label: item.raw_label,
      store: item.store,
      batch_ulid: item.batch_ulid,
      state: item.state,
      on_hand_fraction: item.on_hand_fraction,
      units_total: item.units_total ?? null,
      units_remaining: item.units_remaining ?? null,
      needs_info: item.needs_info,
      acquired_at: item.acquired_at,
      opened_at: null,
      closed_at: null,
      eat_by: item.eat_by,
      shelf_life_class: item.shelf_life_class,
      notes: item.notes,
      created_at: now,
      updated_at: now,
    };
    this.items.set(item.ulid, record);
    return { record: structuredClone(record), created: true };
  }

  async getItem(ulid: string): Promise<InventoryItemRecord | null> {
    const i = this.items.get(ulid);
    return i ? structuredClone(i) : null;
  }

  async listItems(filter: ItemListFilter): Promise<InventoryItemRecord[]> {
    const states = new Set<InventoryState>(filter.states ?? [...DEFAULT_ON_HAND_ITEM_STATES]);
    const limit = Math.min(filter.limit ?? 100, 500);
    return [...this.items.values()]
      .filter((i) => states.has(i.state))
      .sort(nullsLastEatBy)
      .slice(0, limit)
      .map((i) => structuredClone(i));
  }

  async listNeedsInfo(limit: number): Promise<InventoryItemRecord[]> {
    return [...this.items.values()]
      .filter((i) => i.needs_info && (i.state === 'stocked' || i.state === 'open'))
      .sort((a, b) => a.acquired_at.getTime() - b.acquired_at.getTime())
      .slice(0, Math.min(limit, 500))
      .map((i) => structuredClone(i));
  }

  async updateItemState(ulid: string, update: ItemStateUpdate): Promise<InventoryItemRecord | null> {
    const i = this.items.get(ulid);
    if (!i) return null;
    i.state = update.state;
    if (update.opened_at !== undefined) i.opened_at = update.opened_at;
    if (update.closed_at !== undefined) i.closed_at = update.closed_at;
    if (update.on_hand_fraction !== undefined) i.on_hand_fraction = update.on_hand_fraction;
    if (update.units_remaining !== undefined) i.units_remaining = update.units_remaining;
    if (update.units_total !== undefined) i.units_total = update.units_total;
    if (update.eat_by !== undefined) i.eat_by = update.eat_by;
    if (update.notes !== undefined) i.notes = update.notes;
    i.updated_at = new Date();
    return structuredClone(i);
  }

  async setItemFraction(ulid: string, fraction: number): Promise<InventoryItemRecord | null> {
    const i = this.items.get(ulid);
    if (!i) return null;
    i.on_hand_fraction = fraction;
    i.updated_at = new Date();
    return structuredClone(i);
  }

  async resolveNeedsInfo(ulid: string, resolution: ResolveNeedsInfo): Promise<InventoryItemRecord | null> {
    const i = this.items.get(ulid);
    if (!i) return null;
    i.product_ulid = resolution.product_ulid;
    i.shelf_life_class = resolution.shelf_life_class;
    i.eat_by = resolution.eat_by;
    i.needs_info = false;
    i.updated_at = new Date();
    return structuredClone(i);
  }

  async insertBatchIfAbsent(batch: NewBatch): Promise<{ record: PurchaseBatchRecord; created: boolean }> {
    const existing = this.batches.get(batch.ulid);
    if (existing) return { record: structuredClone(existing), created: false };
    const now = new Date();
    const record: PurchaseBatchRecord = {
      ulid: batch.ulid,
      source: batch.source,
      store: batch.store,
      store_undetermined: false,
      purchased_at: batch.purchased_at,
      status: 'parsing',
      parse_attempts: 0,
      last_error: null,
      last_error_at: null,
      created_at: now,
      updated_at: now,
    };
    this.batches.set(batch.ulid, record);
    return { record: structuredClone(record), created: true };
  }

  async getBatch(ulid: string): Promise<PurchaseBatchRecord | null> {
    const b = this.batches.get(ulid);
    return b ? structuredClone(b) : null;
  }

  async listBatches(limit: number): Promise<PurchaseBatchRecord[]> {
    return [...this.batches.values()]
      .sort((a, b) => b.purchased_at.getTime() - a.purchased_at.getTime() || b.created_at.getTime() - a.created_at.getTime())
      .slice(0, Math.min(limit, 500))
      .map((b) => structuredClone(b));
  }

  async selectBatchesForParsing(limit: number, maxAttempts: number): Promise<PurchaseBatchRecord[]> {
    return [...this.batches.values()]
      .filter((b) => b.status === 'parsing' && b.parse_attempts < maxAttempts)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .slice(0, limit)
      .map((b) => structuredClone(b));
  }

  async setBatchStatus(ulid: string, status: BatchStatus): Promise<void> {
    const b = this.batches.get(ulid);
    if (b) {
      b.status = status;
      b.updated_at = new Date();
    }
  }

  async setBatchStoreResolution(
    ulid: string,
    store: string | null,
    storeUndetermined: boolean
  ): Promise<void> {
    const b = this.batches.get(ulid);
    if (b) {
      b.store = store;
      b.store_undetermined = storeUndetermined;
      b.updated_at = new Date();
    }
  }

  async recordBatchParseFailure(ulid: string, error: string): Promise<number> {
    const b = this.batches.get(ulid);
    if (!b) return 0;
    b.parse_attempts += 1;
    b.last_error = error;
    b.last_error_at = new Date();
    b.updated_at = new Date();
    return b.parse_attempts;
  }

  async insertLine(line: NewBatchLine): Promise<BatchLineRecord> {
    const record: BatchLineRecord = { ...line, quantity: line.quantity ?? 1, created_at: new Date() };
    this.lines.set(line.ulid, record);
    return structuredClone(record);
  }

  async listLines(batchUlid: string): Promise<BatchLineRecord[]> {
    return [...this.lines.values()]
      .filter((l) => l.batch_ulid === batchUlid)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map((l) => structuredClone(l));
  }

  async insertDerivation(derivation: NewDerivation): Promise<InventoryDerivationRecord> {
    const record: InventoryDerivationRecord = { ...derivation, created_at: new Date() };
    this.derivations.set(derivation.derived_item_ulid, record);
    return structuredClone(record);
  }

  async getDerivationsByDerivedItemUlids(ulids: string[]): Promise<Map<string, InventoryDerivationRecord>> {
    const map = new Map<string, InventoryDerivationRecord>();
    for (const ulid of ulids) {
      const d = this.derivations.get(ulid);
      if (d) map.set(ulid, structuredClone(d));
    }
    return map;
  }
}
