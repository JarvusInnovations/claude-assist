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
  ItemRelinkCounts,
  LexiconRecord,
  ProductRecord,
  PurchaseBatchRecord,
} from './inventory-types.js';
import type {
  ConversionWrite,
  ConversionWriteResult,
  InventoryStore,
  ItemIdentityPatch,
  ItemListFilter,
  ItemStateUpdate,
  NewBatch,
  NewBatchLine,
  NewDerivation,
  NewItem,
  NewLexicon,
  NewProduct,
  ProductPatch,
  ProductRelinkCounts,
  ResolveNeedsInfo,
} from './inventory-store.js';
import {
  applyItemStateUpdate,
  DEFAULT_ON_HAND_ITEM_STATES,
  TOSS_NOTE_CANDIDATE_PATTERN,
} from './inventory-store.js';
import type { PriceLine } from './inventory-pricing.js';
import { deriveEatBy, normalizeLexiconLine, normalizeProductName } from './inventory-derive.js';

function nullsLastEatBy(a: InventoryItemRecord, b: InventoryItemRecord): number {
  const av = a.eat_by ? a.eat_by.getTime() : Number.POSITIVE_INFINITY;
  const bv = b.eat_by ? b.eat_by.getTime() : Number.POSITIVE_INFINITY;
  if (av !== bv) return av - bv;
  return a.acquired_at.getTime() - b.acquired_at.getTime();
}

/**
 * Test-only fault injection for `applyConversion`. Each hook fires between two
 * of the three write phases, INSIDE the try/catch that rolls every applied side
 * back — so a test can prove atomicity by forcing a mid-operation failure with
 * otherwise-valid input. Never set in production wiring. (Same role as
 * `MemoryConsumeStoreTestHooks.beforeItemWrite`.)
 */
export interface MemoryInventoryStoreTestHooks {
  /** After every source decrement lands, before the derived item is inserted. */
  beforeDerivedInsert?: () => void;
  /** After the derived item is inserted, before the derivation is. */
  beforeDerivationInsert?: () => void;
}

export class MemoryInventoryStore implements InventoryStore {
  readonly products = new Map<string, ProductRecord>();
  readonly lexicon = new Map<string, LexiconRecord>(); // key: `${store}\x00${line_text}`
  readonly items = new Map<string, InventoryItemRecord>();
  readonly batches = new Map<string, PurchaseBatchRecord>();
  readonly lines = new Map<string, BatchLineRecord>();
  readonly derivations = new Map<string, InventoryDerivationRecord>(); // key: derived_item_ulid

  constructor(private hooks: MemoryInventoryStoreTestHooks = {}) {}

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
      net_content_g: product.net_content_g ?? null,
      net_content_ml: product.net_content_ml ?? null,
      unit_edible_g: product.unit_edible_g ?? null,
      nutrition_source: product.nutrition_source ?? null,
      nutrition_negligible: product.nutrition_negligible ?? false,
      archived_at: null,
      merged_into: null,
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
      .filter((p) => !p.archived_at)
      .filter((p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.aliases.some((a) => a.toLowerCase().includes(q))
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((p) => structuredClone(p));
  }

  async findLiveProductsByNormalizedName(normalized: string): Promise<ProductRecord[]> {
    return [...this.products.values()]
      .filter((p) => !p.archived_at && normalizeProductName(p.name) === normalized)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map((p) => structuredClone(p));
  }

  async archiveProduct(ulid: string, mergedInto: string | null = null): Promise<ProductRecord | null> {
    const p = this.products.get(ulid);
    if (!p) return null;
    // First retirement wins — a replay must not slide the stamp forward.
    p.archived_at ??= new Date();
    p.merged_into ??= mergedInto;
    p.updated_at = new Date();
    return structuredClone(p);
  }

  async relinkProductReferences(fromUlid: string, toUlid: string): Promise<ProductRelinkCounts> {
    let items = 0;
    for (const item of this.items.values()) {
      if (item.product_ulid === fromUlid) {
        item.product_ulid = toUlid;
        item.updated_at = new Date();
        items++;
      }
    }
    let lexiconLines = 0;
    for (const line of this.lexicon.values()) {
      if (line.product_ulid === fromUlid) {
        line.product_ulid = toUlid;
        line.updated_at = new Date();
        lexiconLines++;
      }
    }
    let batchLines = 0;
    for (const line of this.lines.values()) {
      if (line.product_ulid === fromUlid) {
        line.product_ulid = toUlid;
        batchLines++;
      }
    }
    return { items, lexicon_lines: lexiconLines, batch_lines: batchLines };
  }

  async getProductsByUlids(ulids: string[]): Promise<Map<string, ProductRecord>> {
    const map = new Map<string, ProductRecord>();
    for (const ulid of ulids) {
      const p = this.products.get(ulid);
      if (p) map.set(ulid, structuredClone(p));
    }
    return map;
  }

  private storeAliases = new Map<string, string>();

  async getStoreAlias(rawStore: string): Promise<string | null> {
    return this.storeAliases.get(rawStore) ?? null;
  }

  async upsertStoreAlias(rawStore: string, resolvedStore: string): Promise<void> {
    this.storeAliases.set(rawStore, resolvedStore);
  }

  async rekeyStore(fromStore: string, toStore: string): Promise<{ lexicon: number; items: number }> {
    let lexicon = 0;
    for (const [k, l] of [...this.lexicon.entries()]) {
      if (l.store !== fromStore) continue;
      // The map is keyed by (store, line), so the row must be re-inserted under
      // the new key rather than mutated in place.
      this.lexicon.delete(k);
      const targetKey = this.lexKey(toStore, l.line_text);
      if (!this.lexicon.has(targetKey)) {
        this.lexicon.set(targetKey, { ...l, store: toStore });
        lexicon += 1;
      }
    }
    let items = 0;
    for (const i of this.items.values()) {
      if (i.store === fromStore) {
        i.store = toStore;
        items += 1;
      }
    }
    await this.upsertStoreAlias(fromStore, toStore);
    return { lexicon, items };
  }

  async listKnownStores(): Promise<string[]> {
    const stores = new Set<string>();
    for (const l of this.lexicon.values()) if (l.store) stores.add(l.store);
    for (const i of this.items.values()) if (i.store) stores.add(i.store);
    return [...stores].sort();
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
      unit_seal: item.unit_seal ?? null,
      needs_info: item.needs_info,
      acquired_at: item.acquired_at,
      opened_at: null,
      closed_at: null,
      storage_moved_at: null,
      eat_by: item.eat_by,
      shelf_life_class: item.shelf_life_class,
      notes: item.notes,
      merged_into: null,
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

  async listTossedCandidates(limit: number): Promise<InventoryItemRecord[]> {
    return [...this.items.values()]
      .filter(
        (i) =>
          i.notes != null &&
          TOSS_NOTE_CANDIDATE_PATTERN.test(i.notes) &&
          i.state !== 'dismissed' &&
          i.merged_into == null
      )
      .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
      .slice(0, Math.min(limit, 500))
      .map((i) => structuredClone(i));
  }

  async updateItemState(ulid: string, update: ItemStateUpdate): Promise<InventoryItemRecord | null> {
    const i = this.items.get(ulid);
    if (!i) return null;
    // Merge through the shared helper (the same one PgInventoryStore's UPDATE
    // and the conversion planner's projection use), then write it back in place
    // so the stored object's identity survives.
    Object.assign(i, applyItemStateUpdate(i, update));
    return structuredClone(i);
  }

  async setItemFraction(ulid: string, fraction: number): Promise<InventoryItemRecord | null> {
    const i = this.items.get(ulid);
    if (!i) return null;
    i.on_hand_fraction = fraction;
    i.updated_at = new Date();
    return structuredClone(i);
  }

  async updateItemIdentity(ulid: string, patch: ItemIdentityPatch): Promise<InventoryItemRecord | null> {
    const i = this.items.get(ulid);
    if (!i) return null;
    Object.assign(i, patch);
    i.updated_at = new Date();
    return structuredClone(i);
  }

  async relinkItemReferences(
    fromUlid: string,
    toUlid: string
  ): Promise<Omit<ItemRelinkCounts, 'entries'>> {
    let batchLines = 0;
    for (const line of this.lines.values()) {
      if (line.inventory_item_ulid === fromUlid) {
        line.inventory_item_ulid = toUlid;
        batchLines++;
      }
    }
    // derived_item_ulid is the map key here (1:1, UNIQUE in pg) — the loser's
    // provenance moves only onto a survivor that has none.
    let derivations = 0;
    const own = this.derivations.get(fromUlid);
    if (own && !this.derivations.has(toUlid)) {
      this.derivations.delete(fromUlid);
      own.derived_item_ulid = toUlid;
      this.derivations.set(toUlid, own);
      derivations++;
    }
    let derivationSources = 0;
    for (const d of this.derivations.values()) {
      if (!d.sources.some((s) => s.item_ulid === fromUlid)) continue;
      d.sources = d.sources.map((s) => (s.item_ulid === fromUlid ? { ...s, item_ulid: toUlid } : s));
      derivationSources++;
    }
    return { batch_lines: batchLines, derivations, derivation_sources: derivationSources };
  }

  async retireMergedItem(ulid: string, mergedInto: string, at: Date): Promise<InventoryItemRecord | null> {
    const i = this.items.get(ulid);
    if (!i) return null;
    i.state = 'dismissed';
    // First retirement wins on both stamps — a replay must not slide either.
    i.closed_at ??= at;
    i.merged_into ??= mergedInto;
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
      total_cents: null,
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

  async setBatchTotal(ulid: string, totalCents: number | null): Promise<void> {
    const b = this.batches.get(ulid);
    if (b) {
      b.total_cents = totalCents;
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
    const record: BatchLineRecord = {
      ...line,
      quantity: line.quantity ?? 1,
      price_cents: line.price_cents ?? null,
      created_at: new Date(),
    };
    this.lines.set(line.ulid, record);
    return structuredClone(record);
  }

  async listLines(batchUlid: string): Promise<BatchLineRecord[]> {
    return [...this.lines.values()]
      .filter((l) => l.batch_ulid === batchUlid)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map((l) => structuredClone(l));
  }

  async listProductPriceLines(filter: {
    product_ulids: string[];
    store?: string;
    limit?: number;
  }): Promise<PriceLine[]> {
    const wanted = new Set(filter.product_ulids.filter(Boolean));
    if (wanted.size === 0) return [];
    const limit = Math.min(filter.limit ?? 200, 1000);
    const joined: { line: BatchLineRecord; batch: PurchaseBatchRecord }[] = [];
    for (const line of this.lines.values()) {
      if (!line.product_ulid || !wanted.has(line.product_ulid)) continue;
      const batch = this.batches.get(line.batch_ulid);
      if (!batch) continue;
      if (filter.store !== undefined && batch.store !== filter.store) continue;
      joined.push({ line, batch });
    }
    return joined
      .sort(
        (a, b) =>
          b.batch.purchased_at.getTime() - a.batch.purchased_at.getTime() ||
          b.line.created_at.getTime() - a.line.created_at.getTime()
      )
      .slice(0, limit)
      .map(({ line, batch }) => ({
        line_ulid: line.ulid,
        batch_ulid: line.batch_ulid,
        product_ulid: line.product_ulid,
        raw_text: line.raw_text,
        quantity: line.quantity,
        price_cents: line.price_cents,
        inventory_item_ulid: line.inventory_item_ulid,
        purchased_at: new Date(batch.purchased_at),
        store: batch.store,
      }));
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

  /**
   * Mirrors PgInventoryStore.applyConversion's semantics — all three write
   * phases land or none do — without a real transaction: each write is applied
   * through the ordinary store method, and any error before the last one has
   * landed restores every touched map entry to its pre-call snapshot before
   * rethrowing. See inventory-store.ts § applyConversion for the rationale.
   */
  async applyConversion(write: ConversionWrite): Promise<ConversionWriteResult> {
    // Idempotency check FIRST, mirroring PgInventoryStore.applyConversion: a
    // caller-supplied derived ULID that already exists means this conversion
    // already happened, so return it having written nothing (§ Conversions §
    // Retries). A server-minted ULID never hits this.
    const replayed = this.items.get(write.derived.ulid);
    if (replayed) {
      const derivation =
        this.derivations.get(write.derived.ulid) ?? (await this.insertDerivation(write.derivation));
      return {
        sources: derivation.sources
          .map((source) => this.items.get(source.item_ulid))
          .filter((item): item is InventoryItemRecord => item !== undefined),
        derived: replayed,
        derivation,
        created: false,
      };
    }

    // Snapshot every source BEFORE touching anything. Keyed by ulid, so a
    // source named twice in one conversion still rolls back to its ONE original
    // state rather than to the intermediate the first decrement produced.
    const before = new Map<string, InventoryItemRecord>();
    for (const source of write.sources) {
      const current = this.items.get(source.item_ulid);
      if (!current) throw new Error(`applyConversion: source item ${source.item_ulid} not found`);
      if (!before.has(source.item_ulid)) before.set(source.item_ulid, structuredClone(current));
    }
    const derivedExisted = this.items.has(write.derived.ulid);
    const derivationBefore = this.derivations.get(write.derivation.derived_item_ulid);

    try {
      const sources: InventoryItemRecord[] = [];
      for (const source of write.sources) {
        const updated = await this.updateItemState(source.item_ulid, source.update);
        if (!updated) throw new Error(`applyConversion: source item ${source.item_ulid} not found`);
        sources.push(updated);
      }

      this.hooks.beforeDerivedInsert?.();
      const { record: derived } = await this.insertItemIfAbsent(write.derived);

      this.hooks.beforeDerivationInsert?.();
      if (this.derivations.has(write.derivation.derived_item_ulid)) {
        // Pg enforces this with a UNIQUE on derived_item_ulid; the mirror has to
        // fail the same way rather than silently overwriting the provenance.
        throw new Error(
          `applyConversion: derivation for derived item ${write.derivation.derived_item_ulid} already exists`
        );
      }
      const derivation = await this.insertDerivation(write.derivation);

      return { sources, derived, derivation, created: true };
    } catch (err) {
      // Roll every side back — a failure here must leave NOTHING applied.
      for (const [ulid, snapshot] of before) this.items.set(ulid, snapshot);
      if (!derivedExisted) this.items.delete(write.derived.ulid);
      if (derivationBefore) this.derivations.set(write.derivation.derived_item_ulid, derivationBefore);
      else this.derivations.delete(write.derivation.derived_item_ulid);
      throw err;
    }
  }
}
