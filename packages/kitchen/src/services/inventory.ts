/**
 * Inventory pipeline (phase 2): receipt intake + parse, label intake, item
 * events, the free-text event resolver, the consumption→inventory depletion
 * matcher, and the read projections. Mirrors the entry pipeline's shape
 * (endpoint-side ingest posts immediately; the model work is detached).
 *
 * Directional + self-healing per specs/modules/kitchen.md § Phase 2: nothing
 * blocks on a model call, unknowns become needs_info items (queued questions),
 * and matching is best-effort — an unmatched remark/entry is normal, not an
 * error.
 */

import type { FastifyBaseLogger } from 'fastify';
import type {
  BatchLineView,
  EventResolution,
  InventoryEventType,
  InventoryItemInput,
  InventoryItemRecord,
  InventoryItemView,
  InventoryPhotoPart,
  InventoryQuestion,
  InventoryState,
  LexiconInput,
  LexiconRecord,
  NutritionPer100g,
  ProductInput,
  ProductRecord,
  PurchaseBatchRecord,
  PurchaseBatchView,
  ReceiptInput,
  ShelfLifeClass,
} from '../inventory-types.js';
import type { InventoryStore, NewItem } from '../inventory-store.js';
import { deriveEatBy, toItemView, toIsoDate } from '../inventory-derive.js';
import { isTerminal, transitionInventory } from '../inventory-state.js';
import { matchScore, parseRemark } from '../inventory-remark.js';
import { generateUlid } from '../ulid.js';
import type { ReceiptParser } from './receipt-parser.js';
import type { LabelParser } from './label-parser.js';

/** Thrown when a label intake is attempted with no label parser configured. */
export class LabelParserUnavailableError extends Error {
  constructor() {
    super('Label extraction requires a configured model (KITCHEN_ESTIMATION_MODEL / API key)');
    this.name = 'LabelParserUnavailableError';
  }
}

export interface InventoryPipelineConfig {
  /** Directional fraction decrement per matched consumption entry (default 0.34). */
  depletionStep?: number;
  /**
   * Link an estimated consumption entry to the inventory item it depleted
   * (sets kitchen.entries.inventory_item_ulid). Injected by the module so the
   * pipeline stays entry-store-agnostic.
   */
  linkEntry?: (entryUlid: string, itemUlid: string) => Promise<void>;
}

/** The minimal entry shape the depletion matcher needs (avoids importing EntryRecord). */
export interface DepletableEntry {
  ulid: string;
  label: string | null;
  status: string;
}

const DEFAULT_QUESTION = (label: string | null): string =>
  `What is “${label ?? 'this item'}”? (product identity + package size)`;

export class InventoryPipeline {
  static readonly MAX_PARSE_ATTEMPTS = 5;

  private depletionStep: number;
  private linkEntry?: (entryUlid: string, itemUlid: string) => Promise<void>;
  private inflight = new Set<Promise<unknown>>();

  constructor(
    private store: InventoryStore,
    private receiptParser: ReceiptParser | null,
    private labelParser: LabelParser | null,
    private log: FastifyBaseLogger,
    config: InventoryPipelineConfig = {}
  ) {
    this.depletionStep = config.depletionStep ?? 0.34;
    this.linkEntry = config.linkEntry;
  }

  // ── Receipt intake ────────────────────────────────────────────────────────

  /**
   * Endpoint-side: post the batch immediately (idempotent on ULID), then
   * detach the parse pass over the in-memory photos. A replay while the batch
   * is still `parsing` re-attempts the parse with the freshly supplied photos
   * (photos are never persisted — the client is the retry's source of truth,
   * exactly as with entries).
   */
  async ingestReceipt(
    input: ReceiptInput,
    photos: InventoryPhotoPart[]
  ): Promise<{ batch: PurchaseBatchView; created: boolean; parse?: Promise<void> }> {
    const purchasedAt = parseDate(input.purchased_at);
    const { record, created } = await this.store.insertBatchIfAbsent({
      ulid: input.ulid,
      source: 'receipt',
      store: input.store?.trim() || null,
      purchased_at: purchasedAt,
    });

    let parse: Promise<void> | undefined;
    if ((created || record.status === 'parsing') && photos.length > 0) {
      parse = this.parseReceiptBatch(record, photos);
      this.detach(parse);
    }
    return { batch: toBatchView(record), created, parse };
  }

  /** Run the cheap receipt model over photos → lines → lexicon lookup → items. */
  private async parseReceiptBatch(batch: PurchaseBatchRecord, photos: InventoryPhotoPart[]): Promise<void> {
    if (!this.receiptParser) {
      // No model configured: the batch stays `parsing`; a later client re-post
      // (with photos) can parse it once a key is set. No attempt burned.
      return;
    }
    try {
      const parsed = await this.receiptParser.parse({ photos, storeHint: batch.store });
      const store = batch.store ?? parsed.store;
      for (const line of parsed.lines) {
        await this.resolveReceiptLine(batch, store, line.text);
      }
      await this.store.setBatchStatus(batch.ulid, 'parsed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = await this.store.recordBatchParseFailure(batch.ulid, message);
      this.log.error(
        { ulid: batch.ulid, attempts, error: message },
        attempts >= InventoryPipeline.MAX_PARSE_ATTEMPTS
          ? 'Receipt parse failed max attempts'
          : 'Receipt parse failed'
      );
      if (attempts >= InventoryPipeline.MAX_PARSE_ATTEMPTS) {
        await this.store.setBatchStatus(batch.ulid, 'failed');
      }
    }
  }

  /** One receipt line: exact-string lexicon lookup per store → matched or needs_info item. */
  private async resolveReceiptLine(
    batch: PurchaseBatchRecord,
    store: string | null,
    rawText: string
  ): Promise<void> {
    const lineText = normalizeLine(rawText);
    const lexicon = store ? await this.store.getLexicon(store, lineText) : null;

    if (lexicon) {
      const product = await this.store.getProduct(lexicon.product_ulid);
      const cls = lexicon.shelf_life_class ?? product?.shelf_life_class ?? 'unknown';
      const item = await this.store.insertItemIfAbsent({
        ulid: generateUlid(),
        product_ulid: lexicon.product_ulid,
        raw_label: rawText,
        store,
        batch_ulid: batch.ulid,
        state: 'stocked',
        on_hand_fraction: 1,
        needs_info: false,
        acquired_at: batch.purchased_at,
        eat_by: deriveEatBy({
          shelfLifeClass: cls,
          acquiredAt: batch.purchased_at,
          openedAt: null,
          daysUnopenedOverride: product?.shelf_life_days_unopened,
          daysOpenedOverride: product?.shelf_life_days_opened,
        }),
        shelf_life_class: cls,
        notes: null,
      });
      await this.store.insertLine({
        ulid: generateUlid(),
        batch_ulid: batch.ulid,
        raw_text: rawText,
        match_outcome: 'matched',
        product_ulid: lexicon.product_ulid,
        inventory_item_ulid: item.record.ulid,
      });
      return;
    }

    // Unknown line: create a needs_info item + record the line as unmatched.
    // The needs_info item IS the queued one-time question (self-clears on label scan).
    const item = await this.store.insertItemIfAbsent({
      ulid: generateUlid(),
      product_ulid: null,
      raw_label: rawText,
      store,
      batch_ulid: batch.ulid,
      state: 'stocked',
      on_hand_fraction: 1,
      needs_info: true,
      acquired_at: batch.purchased_at,
      eat_by: null,
      shelf_life_class: null,
      notes: null,
    });
    await this.store.insertLine({
      ulid: generateUlid(),
      batch_ulid: batch.ulid,
      raw_text: rawText,
      match_outcome: 'unmatched',
      product_ulid: null,
      inventory_item_ulid: item.record.ulid,
    });
  }

  async getBatchView(ulid: string): Promise<{ batch: PurchaseBatchView; lines: BatchLineView[] } | null> {
    const batch = await this.store.getBatch(ulid);
    if (!batch) return null;
    const lines = await this.store.listLines(ulid);
    return { batch: toBatchView(batch), lines: lines.map(toLineView) };
  }

  async listBatchViews(limit = 50): Promise<PurchaseBatchView[]> {
    const batches = await this.store.listBatches(limit);
    return batches.map(toBatchView);
  }

  // ── Label intake ────────────────────────────────────────────────────────────

  /**
   * Resolve a needs_info item from a label photo: extract product facts,
   * create/enrich the product, clear needs_info + re-derive eat_by, and write
   * the receipt-lexicon line so the same store+line text auto-resolves next time.
   */
  async resolveLabel(
    itemUlid: string,
    photos: InventoryPhotoPart[],
    meta: { name?: string; shelf_life_class?: ShelfLifeClass; package_size?: string; aliases?: string[] } = {}
  ): Promise<{ item: InventoryItemView; product: ProductRecord } | null> {
    const item = await this.store.getItem(itemUlid);
    if (!item) return null;
    if (!this.labelParser && photos.length > 0) throw new LabelParserUnavailableError();

    const parsed = photos.length > 0 && this.labelParser
      ? await this.labelParser.parse({ photos, hint: item.raw_label })
      : { name: null, shelf_life_class: null, package_size: null, nutrition_per_100g: null, aliases: [] as string[] };

    const name = meta.name?.trim() || parsed.name || item.raw_label || 'Unlabeled item';
    const cls: ShelfLifeClass = meta.shelf_life_class ?? parsed.shelf_life_class ?? 'unknown';
    const packageSize = meta.package_size ?? parsed.package_size ?? null;
    const aliases = dedupeAliases([...(meta.aliases ?? []), ...parsed.aliases]);
    const nutrition = normalizeNutrition(parsed.nutrition_per_100g);

    // Enrich an existing product (same name) or create one.
    const product = await this.upsertProductByName({
      name,
      shelf_life_class: cls,
      aliases,
      nutrition_per_100g: nutrition,
      package_size: packageSize,
    });

    const eatBy = deriveEatBy({
      shelfLifeClass: product.shelf_life_class,
      acquiredAt: item.acquired_at,
      openedAt: item.opened_at,
      daysUnopenedOverride: product.shelf_life_days_unopened,
      daysOpenedOverride: product.shelf_life_days_opened,
    });
    const resolved = await this.store.resolveNeedsInfo(itemUlid, {
      product_ulid: product.ulid,
      shelf_life_class: product.shelf_life_class,
      eat_by: eatBy,
    });

    // Write the lexicon line so future receipts carrying this exact text
    // auto-resolve with no question.
    if (item.store && item.raw_label) {
      await this.store.upsertLexicon({
        ulid: generateUlid(),
        store: item.store,
        line_text: normalizeLine(item.raw_label),
        product_ulid: product.ulid,
        package_size: packageSize,
        shelf_life_class: product.shelf_life_class,
      });
    }

    return { item: await this.viewOf(resolved ?? item), product };
  }

  // ── Item events ───────────────────────────────────────────────────────────

  /** Explicit state change on an item (opened | finished | tossed), optional fraction. */
  async applyEvent(
    itemUlid: string,
    type: InventoryEventType,
    opts: { fraction?: number; at?: string } = {}
  ): Promise<InventoryItemView | null> {
    const item = await this.store.getItem(itemUlid);
    if (!item) return null;
    const updated = await this.applyEventToRecord(item, type, opts);
    return updated ? this.viewOf(updated) : null;
  }

  /** Shared side-effect application used by both the explicit endpoint and the resolver. */
  private async applyEventToRecord(
    item: InventoryItemRecord,
    type: InventoryEventType,
    opts: { fraction?: number; at?: string }
  ): Promise<InventoryItemRecord | null> {
    const nextState = transitionInventory(item.state, type); // throws on terminal
    const at = parseDate(opts.at);

    if (type === 'opened') {
      const eatBy = deriveEatBy({
        shelfLifeClass: item.shelf_life_class,
        acquiredAt: item.acquired_at,
        openedAt: at,
        // No product join here — the item's snapshot class drives it; product
        // overrides were already folded into eat_by at stock/label time.
      });
      const fraction = opts.fraction ?? item.on_hand_fraction;
      return this.store.updateItemState(item.ulid, {
        state: nextState,
        opened_at: item.opened_at ?? at,
        on_hand_fraction: fraction,
        eat_by: eatBy,
      });
    }

    // finished | tossed: terminal, zero the fraction, stamp closed_at.
    return this.store.updateItemState(item.ulid, {
      state: nextState,
      closed_at: at,
      on_hand_fraction: 0,
    });
  }

  // ── Free-text event resolver ─────────────────────────────────────────────────

  /**
   * Best-effort: parse a remark into an event + fraction + search term, match
   * against on-hand items (string/alias, directional), and apply the state
   * change to the single best match. An unmatched remark is a normal no-op.
   */
  async resolveRemark(remark: string, at?: string): Promise<EventResolution> {
    const parsed = parseRemark(remark);
    if (!parsed || !parsed.term) return { matched: false };

    const onHand = await this.store.listItems({ states: ['stocked', 'open'], limit: 500 });
    const products = await this.productMap(onHand);
    const best = this.bestItemMatch(parsed.term, onHand, products);
    if (!best) return { matched: false };

    // A `tossed` with a fraction < 1 is a partial toss: decrement rather than
    // terminate. Everything else applies the full state change.
    if (parsed.type === 'tossed' && parsed.fraction !== null && parsed.fraction < 1) {
      const next = clampFraction(best.on_hand_fraction - parsed.fraction);
      const updated = await this.store.setItemFraction(best.ulid, next);
      return {
        matched: true,
        item: await this.viewOf(updated ?? best),
        event: { type: 'tossed', fraction: parsed.fraction },
      };
    }

    try {
      const updated = await this.applyEventToRecord(best, parsed.type, { fraction: undefined, at });
      return {
        matched: true,
        item: updated ? await this.viewOf(updated) : undefined,
        event: { type: parsed.type, fraction: parsed.fraction },
      };
    } catch {
      // Terminal item matched (already finished/tossed) — treat as unmatched.
      return { matched: false };
    }
  }

  // ── Depletion matcher (consumption → inventory) ──────────────────────────────

  /**
   * After a consumption entry reaches terminal `estimated`, conservatively
   * match its label against on-hand items and decrement the single best match's
   * fraction, linking the entry. Ambiguous/absent match = no-op. No model call.
   */
  async matchAndDeplete(entry: DepletableEntry): Promise<InventoryItemView | null> {
    if (entry.status !== 'estimated' || !entry.label) return null;
    const onHand = await this.store.listItems({ states: ['stocked', 'open'], limit: 500 });
    const products = await this.productMap(onHand);
    const best = this.bestItemMatch(entry.label, onHand, products, 2 /* conservative */);
    if (!best) return null;

    const next = clampFraction(best.on_hand_fraction - this.depletionStep);
    const updated = await this.store.setItemFraction(best.ulid, next);
    if (this.linkEntry) {
      try {
        await this.linkEntry(entry.ulid, best.ulid);
      } catch (err) {
        this.log.warn({ err, entry: entry.ulid, item: best.ulid }, 'Failed to link depleted entry');
      }
    }
    return updated ? this.viewOf(updated) : null;
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  async listInventory(filter: { states?: InventoryState[]; limit?: number }): Promise<InventoryItemView[]> {
    const items = await this.store.listItems(filter);
    return this.viewsOf(items);
  }

  async getItemView(ulid: string): Promise<InventoryItemView | null> {
    const item = await this.store.getItem(ulid);
    return item ? this.viewOf(item) : null;
  }

  async listQuestions(limit = 50): Promise<InventoryQuestion[]> {
    const items = await this.store.listNeedsInfo(limit);
    return items.map((i) => ({
      item_ulid: i.ulid,
      raw_label: i.raw_label,
      store: i.store,
      acquired_at: toIsoDate(i.acquired_at)!,
      question: DEFAULT_QUESTION(i.raw_label),
    }));
  }

  // ── Direct item / product / lexicon creation (manual + agentic seed) ──────────

  async createItem(input: InventoryItemInput): Promise<{ item: InventoryItemView; created: boolean }> {
    const acquiredAt = parseDate(input.acquired_at);
    const cls = input.shelf_life_class ?? null;
    let productCls: ShelfLifeClass | null = cls;
    let product: ProductRecord | null = null;
    if (input.product_ulid) {
      product = await this.store.getProduct(input.product_ulid);
      productCls = cls ?? product?.shelf_life_class ?? null;
    }
    const needsInfo = input.needs_info ?? (!input.product_ulid && !cls);
    const eatBy = needsInfo
      ? null
      : deriveEatBy({
          shelfLifeClass: productCls,
          acquiredAt,
          openedAt: null,
          daysUnopenedOverride: product?.shelf_life_days_unopened,
          daysOpenedOverride: product?.shelf_life_days_opened,
        });
    const newItem: NewItem = {
      ulid: input.ulid ?? generateUlid(),
      product_ulid: input.product_ulid ?? null,
      raw_label: input.raw_label ?? null,
      store: input.store ?? null,
      batch_ulid: input.batch_ulid ?? null,
      state: input.state ?? 'stocked',
      on_hand_fraction: input.on_hand_fraction ?? 1,
      needs_info: needsInfo,
      acquired_at: acquiredAt,
      eat_by: eatBy,
      shelf_life_class: productCls,
      notes: input.notes ?? null,
    };
    const { record, created } = await this.store.insertItemIfAbsent(newItem);
    return { item: await this.viewOf(record), created };
  }

  async createProduct(input: ProductInput): Promise<ProductRecord> {
    return this.store.insertProduct({
      ulid: generateUlid(),
      name: input.name.trim(),
      shelf_life_class: input.shelf_life_class ?? 'unknown',
      aliases: dedupeAliases(input.aliases ?? []),
      nutrition_per_100g: normalizeNutrition(input.nutrition_per_100g),
      package_size: input.package_size ?? null,
      shelf_life_days_unopened: input.shelf_life_days_unopened ?? null,
      shelf_life_days_opened: input.shelf_life_days_opened ?? null,
    });
  }

  async listProducts(filter: { q?: string; limit?: number }): Promise<ProductRecord[]> {
    return this.store.listProducts(filter);
  }

  async upsertLexicon(input: LexiconInput): Promise<LexiconRecord> {
    return this.store.upsertLexicon({
      ulid: generateUlid(),
      store: input.store,
      line_text: normalizeLine(input.line_text),
      product_ulid: input.product_ulid,
      package_size: input.package_size ?? null,
      shelf_life_class: input.shelf_life_class ?? null,
    });
  }

  async listLexicon(filter: { store?: string; limit?: number }): Promise<LexiconRecord[]> {
    return this.store.listLexicon(filter);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async upsertProductByName(input: ProductInput & { name: string }): Promise<ProductRecord> {
    const matches = await this.store.listProducts({ q: input.name, limit: 20 });
    const exact = matches.find((p) => p.name.toLowerCase() === input.name.toLowerCase());
    if (exact) {
      const merged = await this.store.updateProduct(exact.ulid, {
        shelf_life_class: input.shelf_life_class && input.shelf_life_class !== 'unknown'
          ? input.shelf_life_class
          : exact.shelf_life_class,
        aliases: dedupeAliases([...exact.aliases, ...(input.aliases ?? [])]),
        nutrition_per_100g: normalizeNutrition(input.nutrition_per_100g) ?? exact.nutrition_per_100g,
        package_size: input.package_size ?? exact.package_size,
      });
      return merged ?? exact;
    }
    return this.createProduct(input);
  }

  /** Single unambiguous best item match for a query, or null (tie / below threshold). */
  private bestItemMatch(
    query: string,
    items: InventoryItemRecord[],
    products: Map<string, ProductRecord>,
    minScore = 1
  ): InventoryItemRecord | null {
    let best: { item: InventoryItemRecord; score: number } | null = null;
    let tie = false;
    for (const item of items) {
      const candidates = candidateStrings(item, item.product_ulid ? products.get(item.product_ulid) : undefined);
      const score = Math.max(0, ...candidates.map((c) => matchScore(query, c)));
      if (score < minScore) continue;
      if (!best || score > best.score) {
        best = { item, score };
        tie = false;
      } else if (score === best.score) {
        tie = true;
      }
    }
    if (!best || tie) return null;
    return best.item;
  }

  private async productMap(items: InventoryItemRecord[]): Promise<Map<string, ProductRecord>> {
    const ulids = [...new Set(items.map((i) => i.product_ulid).filter((u): u is string => !!u))];
    return this.store.getProductsByUlids(ulids);
  }

  private async viewOf(item: InventoryItemRecord): Promise<InventoryItemView> {
    const product = item.product_ulid ? await this.store.getProduct(item.product_ulid) : null;
    return toItemView(item, product?.name ?? null);
  }

  private async viewsOf(items: InventoryItemRecord[]): Promise<InventoryItemView[]> {
    const products = await this.productMap(items);
    return items.map((i) => toItemView(i, i.product_ulid ? products.get(i.product_ulid)?.name ?? null : null));
  }

  private detach(p: Promise<unknown>): void {
    this.inflight.add(p);
    void Promise.resolve(p)
      .catch((error) => this.log.error({ error }, 'Detached inventory task rejected'))
      .finally(() => this.inflight.delete(p));
  }

  /** Await all in-flight detached tasks (tests, graceful shutdown). */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Normalize a receipt line for exact-string lexicon matching (upper + collapse ws). */
export function normalizeLine(text: string): string {
  return text.trim().toUpperCase().replace(/\s+/g, ' ');
}

/** Candidate match strings for an item: product name + aliases + raw label. */
export function candidateStrings(item: InventoryItemRecord, product?: ProductRecord): string[] {
  const out: string[] = [];
  if (product) {
    out.push(product.name, ...product.aliases);
  }
  if (item.raw_label) out.push(item.raw_label);
  return out.filter(Boolean);
}

function clampFraction(n: number): number {
  return Math.max(0, Math.min(1, Math.round(n * 1000) / 1000));
}

function dedupeAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of aliases) {
    const t = a.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function normalizeNutrition(input: Partial<NutritionPer100g> | null | undefined): NutritionPer100g | null {
  if (!input) return null;
  const keys: (keyof NutritionPer100g)[] = ['calories', 'protein_g', 'fat_g', 'sat_fat_g', 'carbs_g', 'sodium_mg'];
  const out = {} as NutritionPer100g;
  let any = false;
  for (const k of keys) {
    const v = input[k];
    out[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
    if (out[k] !== null) any = true;
  }
  return any ? out : null;
}

/** Parse an ISO date/date-time to a day-normalized (UTC midnight) Date; default today. */
export function parseDate(input?: string | null): Date {
  if (!input) return new Date(new Date().toISOString().slice(0, 10));
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return new Date(new Date().toISOString().slice(0, 10));
  return new Date(d.toISOString().slice(0, 10));
}

function toBatchView(b: PurchaseBatchRecord): PurchaseBatchView {
  return {
    ulid: b.ulid,
    source: b.source,
    store: b.store,
    purchased_at: toIsoDate(b.purchased_at)!,
    status: b.status,
    parse_attempts: b.parse_attempts,
    last_error: b.last_error,
    created_at: b.created_at.toISOString(),
    updated_at: b.updated_at.toISOString(),
  };
}

function toLineView(l: BatchLineView | import('../inventory-types.js').BatchLineRecord): BatchLineView {
  return {
    ulid: l.ulid,
    batch_ulid: l.batch_ulid,
    raw_text: l.raw_text,
    match_outcome: l.match_outcome,
    product_ulid: l.product_ulid,
    inventory_item_ulid: l.inventory_item_ulid,
    created_at: typeof l.created_at === 'string' ? l.created_at : l.created_at.toISOString(),
  };
}
