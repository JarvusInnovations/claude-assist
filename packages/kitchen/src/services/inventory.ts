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
  ConsumeInput,
  ConsumeResult,
  ConvertInput,
  ConvertResult,
  DerivationSource,
  DerivedFromView,
  DismissResolution,
  EventResolution,
  InventoryDerivationRecord,
  InventoryEventType,
  InventoryItemInput,
  InventoryItemRecord,
  InventoryItemView,
  InventoryPhotoPart,
  InventoryQuestion,
  InventoryState,
  LabelResolution,
  LexiconInput,
  LexiconRecord,
  NutritionPer100g,
  ParsedReceiptLine,
  ProductInput,
  ProductRecord,
  PurchaseBatchRecord,
  PurchaseBatchView,
  ReceiptInput,
  ShelfLifeClass,
} from '../inventory-types.js';
import type { InventoryStore, ItemStateUpdate, NewItem } from '../inventory-store.js';
import { deriveEatBy, normalizeLexiconLine, parsePackageCount, toItemView, toIsoDate } from '../inventory-derive.js';
import { InvalidTransitionError, isTerminal, transitionInventory } from '../inventory-state.js';
import { matchScore, parseRemark } from '../inventory-remark.js';
import { generateUlid } from '../ulid.js';
import type { ReceiptParser } from './receipt-parser.js';
import type { LabelParser } from './label-parser.js';
import type { ConsumeStore } from './consume-store.js';
import { computeRecipeMacros, round1 } from './recipes.js';
import type { NutritionFields, RecipeRecord } from '../types.js';

/** Thrown when a label intake is attempted with no label parser configured. */
export class LabelParserUnavailableError extends Error {
  constructor() {
    super('Label extraction requires a configured model (KITCHEN_ESTIMATION_MODEL / API key)');
    this.name = 'LabelParserUnavailableError';
  }
}

/** Thrown when a count-only event (`finished-unit`) targets a fraction-modeled item. */
export class NotCountedItemError extends Error {
  constructor(itemUlid: string) {
    super(`Inventory item ${itemUlid} is fraction-modeled, not counted (no units_total) — use 'finished' or 'tossed'`);
    this.name = 'NotCountedItemError';
  }
}

/** Thrown on malformed `convert` input (missing fields, unknown source, bad amount) — a 400 at the route. */
export class ConversionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversionValidationError';
  }
}

/**
 * Thrown by `consume()` when the item does not qualify for one-tap consume
 * (specs/modules/kitchen.md § Consume from inventory — eligibility rule): its
 * macros are not deterministically knowable, because it carries no
 * recipe-linked derivation provenance, or that provenance's recipe can't be
 * resolved / has no components. Mapped to `400` at the route — the app
 * should route this item through the normal photo/reselect path instead.
 */
export class ConsumeIneligibleError extends Error {
  constructor(itemUlid: string, reason: string) {
    super(`Inventory item ${itemUlid} is not consume-eligible: ${reason}`);
    this.name = 'ConsumeIneligibleError';
  }
}

/** Thrown on malformed `consume` input (bad quantity, nothing on hand) — a 400 at the route. */
export class ConsumeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsumeValidationError';
  }
}

/**
 * Thrown when `consume()` is called but the module wasn't wired with a
 * `consumeStore` and/or `resolveRecipe` (deployment/config gap, not a
 * per-item problem) — mapped to `503` at the route, mirroring
 * `LabelParserUnavailableError`.
 */
export class ConsumeNotConfiguredError extends Error {
  constructor() {
    super('Consume-from-inventory requires both consumeStore and resolveRecipe to be configured');
    this.name = 'ConsumeNotConfiguredError';
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
  /**
   * Atomic cross-table writer for `consume()` (claude-assist#110): inserts
   * the consumption entry and depletes the item in ONE transaction. Required
   * for `consume()` to succeed — absent, `consume()` throws
   * `ConsumeNotConfiguredError`.
   */
  consumeStore?: ConsumeStore;
  /**
   * Resolve a recipe by ulid across BOTH persisted (DB) and sheet-sourced
   * recipes — the same merged universe `KitchenPipeline.listAllRecipes()`
   * serves. `consume()` uses this to compute a derived item's inherited
   * macros from its conversion's `recipe_ulid` provenance. Required for
   * `consume()` to succeed — absent, `consume()` throws
   * `ConsumeNotConfiguredError`.
   */
  resolveRecipe?: (recipeUlid: string) => Promise<RecipeRecord | null>;
}

/** The minimal entry shape the depletion matcher needs (avoids importing EntryRecord). */
export interface DepletableEntry {
  ulid: string;
  label: string | null;
  status: string;
}

/** Digest/chat question text for a needs-info line; notes the count when > 1. */
function questionText(label: string | null, count: number): string {
  const suffix = count > 1 ? ` (×${count})` : '';
  return `What is “${label ?? 'this item'}”${suffix}? (product identity + package size)`;
}

export class InventoryPipeline {
  static readonly MAX_PARSE_ATTEMPTS = 5;

  private depletionStep: number;
  private linkEntry?: (entryUlid: string, itemUlid: string) => Promise<void>;
  private consumeStore?: ConsumeStore;
  private resolveRecipe?: (recipeUlid: string) => Promise<RecipeRecord | null>;
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
    this.consumeStore = config.consumeStore;
    this.resolveRecipe = config.resolveRecipe;
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
      // Precedence: an explicit meta store overrides the header extraction.
      const store = batch.store ?? parsed.store;
      // Persist the resolution back onto the batch when it wasn't meta-supplied:
      // stamp the extracted store, or record `store_undetermined` when neither
      // source yielded one (a null store is corrosive+silent — the lexicon is
      // keyed on store, so it must be a visible gap, not an invisible one).
      if (batch.store == null) {
        await this.store.setBatchStoreResolution(batch.ulid, store, store == null);
      }
      for (const line of parsed.lines) {
        await this.resolveReceiptLine(batch, store, line);
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

  /**
   * One receipt line → batch line + inventory item(s). Resolution order
   * (specs/modules/kitchen.md § POST /receipts, § Conservative non-food skip):
   *   1. durable `non_inventory` lexicon marker → `skipped`, no item;
   *   2. durable product mapping → `matched`, N stocked items (wins over a
   *      model non_food guess — owner intent beats the first-pass judgment);
   *   3. model judged clearly non-food (no lexicon hit) → `skipped`, no item
   *      (per-receipt only — never writes a lexicon marker);
   *   4. unknown → `unmatched`, N needs_info items (the queued question).
   * A multi-quantity line (`quantity: N`) fans out to N items (one lifecycle
   * each) and records N on the batch line, which points at the representative
   * (earliest) unit.
   */
  private async resolveReceiptLine(
    batch: PurchaseBatchRecord,
    store: string | null,
    line: ParsedReceiptLine
  ): Promise<void> {
    const rawText = line.text;
    const quantity = Math.max(1, Math.floor(line.quantity ?? 1));
    const lineText = normalizeLine(rawText);
    const lexicon = store ? await this.store.getLexicon(store, lineText) : null;

    // 1. Non-inventory marker: a line the owner previously flagged "never
    // inventory". Skip stocking it, but record the line (never silently drop
    // it) so the batch stays a faithful receipt record.
    if (lexicon?.non_inventory) {
      await this.recordSkippedLine(batch, rawText, quantity);
      return;
    }

    // 2. Product mapping → N stocked items. A durable mapping stocks even when
    // the model guessed non_food.
    if (lexicon && lexicon.product_ulid) {
      const productUlid = lexicon.product_ulid;
      const product = await this.store.getProduct(productUlid);
      const cls = lexicon.shelf_life_class ?? product?.shelf_life_class ?? 'unknown';
      const eatBy = deriveEatBy({
        shelfLifeClass: cls,
        acquiredAt: batch.purchased_at,
        openedAt: null,
        daysUnopenedOverride: product?.shelf_life_days_unopened,
        daysOpenedOverride: product?.shelf_life_days_opened,
      });
      // Sealed-unit count model (§ count-vs-fraction principle): a package
      // size that carries a discernible count ("3 ct", "12-pack") seeds
      // units_total on EACH fanned-out item (one multipack per physical unit
      // bought — orthogonal to the receipt line's own `quantity` fan-out).
      // The lexicon line's package_size wins over the product's; no count
      // found (a plain size like "16 oz") leaves the item fraction-modeled.
      const unitsTotal = parsePackageCount(lexicon.package_size ?? product?.package_size ?? null);
      const firstUlid = await this.fanOutItems(quantity, () => ({
        ulid: generateUlid(),
        product_ulid: productUlid,
        raw_label: rawText,
        store,
        batch_ulid: batch.ulid,
        state: 'stocked',
        on_hand_fraction: 1,
        units_total: unitsTotal,
        units_remaining: unitsTotal,
        needs_info: false,
        acquired_at: batch.purchased_at,
        eat_by: eatBy,
        shelf_life_class: cls,
        notes: null,
      }));
      await this.store.insertLine({
        ulid: generateUlid(),
        batch_ulid: batch.ulid,
        raw_text: rawText,
        quantity,
        match_outcome: 'matched',
        product_ulid: productUlid,
        inventory_item_ulid: firstUlid,
      });
      return;
    }

    // 3. Model judged the line clearly non-food (and the lexicon has never seen
    // it): record it `skipped`, mint no item. Conservative — only fires on the
    // model's explicit flag; ambiguous lines fall through to needs_info below.
    if (line.non_food === true) {
      await this.recordSkippedLine(batch, rawText, quantity);
      return;
    }

    // 4. Unknown line: N needs_info items + record the line unmatched. The
    // needs_info items ARE the queued one-time question (self-clear on label
    // scan; deduped into one question carrying the count).
    const firstUlid = await this.fanOutItems(quantity, () => ({
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
    }));
    await this.store.insertLine({
      ulid: generateUlid(),
      batch_ulid: batch.ulid,
      raw_text: rawText,
      quantity,
      match_outcome: 'unmatched',
      product_ulid: null,
      inventory_item_ulid: firstUlid,
    });
  }

  /** Record a batch line that stocks nothing (skipped), retaining the quantity. */
  private async recordSkippedLine(
    batch: PurchaseBatchRecord,
    rawText: string,
    quantity: number
  ): Promise<void> {
    await this.store.insertLine({
      ulid: generateUlid(),
      batch_ulid: batch.ulid,
      raw_text: rawText,
      quantity,
      match_outcome: 'skipped',
      product_ulid: null,
      inventory_item_ulid: null,
    });
  }

  /**
   * Insert `count` inventory items (each its own physical unit + ULID) from a
   * factory and return the representative (first-created) item's ULID for the
   * batch line to point at. `count` is ≥ 1.
   */
  private async fanOutItems(count: number, make: () => NewItem): Promise<string> {
    let firstUlid: string | null = null;
    for (let i = 0; i < count; i++) {
      const { record } = await this.store.insertItemIfAbsent(make());
      if (firstUlid === null) firstUlid = record.ulid;
    }
    return firstUlid!;
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
   * Intake a label scan on any **non-terminal** item (specs/modules/kitchen.md
   * § POST /inventory/:ulid/label). Extract product facts from the photos
   * (multiple photos are complementary views of one product — front + panels),
   * then, by the item's state:
   *
   * - **needs_info** — resolve: enrich/create the product, link it, clear
   *   needs_info + re-derive eat_by, fan out to same-line siblings, and write
   *   the receipt-lexicon line so the same store+line text auto-resolves next
   *   time.
   * - **already-linked (product set, not needs_info)** — enrich the *linked*
   *   product only (per-field precedence, never null-clobbering) + write the
   *   lexicon line; the item itself is left untouched. Banks a later
   *   nutrition/ingredients scan onto an already-stocked item.
   * - **unlinked, not needs_info** (edge) — treated like resolve.
   *
   * Throws InvalidTransitionError (→ 409) on a terminal item.
   */
  async resolveLabel(
    itemUlid: string,
    photos: InventoryPhotoPart[],
    meta: {
      name?: string;
      shelf_life_class?: ShelfLifeClass;
      package_size?: string;
      aliases?: string[];
      ingredients?: string;
    } = {}
  ): Promise<LabelResolution | null> {
    const item = await this.store.getItem(itemUlid);
    if (!item) return null;
    if (isTerminal(item.state)) throw new InvalidTransitionError(item.state, 'opened');
    if (!this.labelParser && photos.length > 0) throw new LabelParserUnavailableError();

    const parsed = photos.length > 0 && this.labelParser
      ? await this.labelParser.parse({ photos, hint: item.raw_label })
      : {
          name: null,
          shelf_life_class: null,
          package_size: null,
          nutrition_per_100g: null,
          ingredients: null,
          aliases: [] as string[],
        };

    const name = meta.name?.trim() || parsed.name || item.raw_label || 'Unlabeled item';
    const cls: ShelfLifeClass = meta.shelf_life_class ?? parsed.shelf_life_class ?? 'unknown';
    const packageSize = meta.package_size ?? parsed.package_size ?? null;
    const aliases = dedupeAliases([...(meta.aliases ?? []), ...parsed.aliases]);
    const nutrition = normalizeNutrition(parsed.nutrition_per_100g);
    const ingredients = meta.ingredients?.trim() || parsed.ingredients || null;
    const productInput: ProductInput & { name: string } = {
      name,
      shelf_life_class: cls,
      aliases,
      nutrition_per_100g: nutrition,
      ingredients,
      package_size: packageSize,
    };

    // Enrich path: an already-linked, non-needs_info item. Bank the parsed panel
    // onto the LINKED product (ground truth, not a name match) and update the
    // lexicon line, but leave the item's state/link/eat_by untouched.
    if (item.product_ulid && !item.needs_info) {
      const linked = await this.store.getProduct(item.product_ulid);
      if (linked) {
        const enriched = await this.enrichProduct(linked, productInput);
        await this.writeLexiconLine(item, enriched, packageSize);
        return { item: await this.viewOf(item), product: enriched, resolved_count: 1 };
      }
      // Linked product vanished — fall through to the resolve path.
    }

    // Resolve path: enrich an existing product (same name) or create one.
    const product = await this.upsertProductByName(productInput);

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

    // Fan out across the current batch's same-line siblings (a multi-quantity
    // line makes one item per physical unit; one label scan clears them all).
    // Captured BEFORE the lexicon write: writeLexiconLine's upsert now also
    // retro-resolves same-line needs_info items itself (claude-assist#102),
    // which would otherwise empty this query out from under us (already-
    // resolved siblings drop out of listNeedsInfo) and undercount
    // resolved_count. The explicit resolveNeedsInfo below stays — it's an
    // idempotent no-op re-write when the lexicon write already resolved a
    // sibling, and the only path at all when it didn't.
    const siblings =
      item.store && item.raw_label
        ? await this.sameLineNeedsInfoSiblings(item.store, item.raw_label, itemUlid)
        : [];

    // Write the lexicon line so future receipts carrying this exact text
    // auto-resolve with no question. Both need (store, raw_label).
    let resolvedCount = 1;
    await this.writeLexiconLine(item, product, packageSize);
    for (const sib of siblings) {
      // Same product + class, but eat_by re-derived from THIS sibling's own
      // acquired/opened clock — they are distinct physical units.
      await this.store.resolveNeedsInfo(sib.ulid, {
        product_ulid: product.ulid,
        shelf_life_class: product.shelf_life_class,
        eat_by: deriveEatBy({
          shelfLifeClass: product.shelf_life_class,
          acquiredAt: sib.acquired_at,
          openedAt: sib.opened_at,
          daysUnopenedOverride: product.shelf_life_days_unopened,
          daysOpenedOverride: product.shelf_life_days_opened,
        }),
      });
      resolvedCount += 1;
    }

    return { item: await this.viewOf(resolved ?? item), product, resolved_count: resolvedCount };
  }

  /**
   * Open `needs_info` siblings sharing `(store, normalized raw_label)` with a
   * scanned item, excluding the scanned item itself. Used by the label fan-out
   * and the non-inventory dismissal fan-out. Single-user scale — a generous
   * needs_info scan + in-memory filter (normalization lives here, not the store).
   */
  private async sameLineNeedsInfoSiblings(
    store: string,
    rawLabel: string,
    excludeUlid: string
  ): Promise<InventoryItemRecord[]> {
    const norm = normalizeLine(rawLabel);
    const all = await this.store.listNeedsInfo(500);
    return all.filter(
      (i) =>
        i.ulid !== excludeUlid &&
        i.store === store &&
        i.raw_label != null &&
        normalizeLine(i.raw_label) === norm
    );
  }

  /**
   * Upsert the `(store, normalized raw_label)` → product lexicon line for a
   * scanned item so future receipts carrying the same line auto-resolve. A null
   * store or raw_label is a no-op (the lexicon key would be incomplete — see
   * § Store extraction & precedence). Shared by both label paths.
   */
  private async writeLexiconLine(
    item: InventoryItemRecord,
    product: ProductRecord,
    packageSize: string | null
  ): Promise<void> {
    if (!item.store || !item.raw_label) return;
    await this.store.upsertLexicon({
      ulid: generateUlid(),
      store: item.store,
      line_text: normalizeLine(item.raw_label),
      product_ulid: product.ulid,
      package_size: packageSize,
      shelf_life_class: product.shelf_life_class,
    });
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

  /**
   * Shared side-effect application used by both the explicit endpoint and the
   * free-text resolver. Fraction semantics per event type:
   * - `opened`: optional absolute remaining fraction (defaults to unchanged).
   * - `tossed`: optional AMOUNT tossed — decrements on-hand and terminates
   *   (state `tossed`) only when the remainder reaches zero or no fraction was
   *   supplied (full toss). The tossed amount is appended to the item's
   *   `notes` (`tossed <amount> <date>`) so waste telemetry stays possible.
   * - `finished`: always terminal and zeroing (on_hand_fraction AND, when the
   *   item is counted, units_remaining — a whole-item finish means none left).
   * - `finished-unit`: counted items only (§ count-vs-fraction principle) — an
   *   integer decrement of ONE sealed unit. Reaching zero remaining goes
   *   terminal `finished`, same as a whole-item finish; otherwise the item
   *   reverts to `stocked` with a fresh unopened-window eat_by — the unit that
   *   was just finished carried the opened clock, but the sealed remainder was
   *   never itself opened, so the next-to-open unit starts its own clock from
   *   `acquired_at`, not from the just-finished unit's `opened_at`.
   */
  private async applyEventToRecord(
    item: InventoryItemRecord,
    type: InventoryEventType,
    opts: { fraction?: number; at?: string }
  ): Promise<InventoryItemRecord | null> {
    const at = parseDate(opts.at);

    if (type === 'finished-unit') {
      if (item.units_total == null || item.units_remaining == null) {
        throw new NotCountedItemError(item.ulid);
      }
      if (isTerminal(item.state)) throw new InvalidTransitionError(item.state, 'finished-unit');
      const remaining = Math.max(0, item.units_remaining - 1);
      if (remaining === 0) {
        return this.store.updateItemState(item.ulid, {
          state: 'finished',
          closed_at: at,
          on_hand_fraction: 0,
          units_remaining: 0,
        });
      }
      const eatBy = deriveEatBy({ shelfLifeClass: item.shelf_life_class, acquiredAt: item.acquired_at, openedAt: null });
      return this.store.updateItemState(item.ulid, {
        state: 'stocked',
        opened_at: null,
        eat_by: eatBy,
        units_remaining: remaining,
      });
    }

    const nextState = transitionInventory(item.state, type); // throws on terminal

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

    if (type === 'tossed') {
      // Amount tossed: the supplied fraction, or everything on hand (full toss).
      const tossedAmount = clampFraction(opts.fraction ?? item.on_hand_fraction);
      const remaining = clampFraction(item.on_hand_fraction - tossedAmount);
      const wasteNote = `tossed ${tossedAmount} ${toIsoDate(at)}`;
      const notes = item.notes ? `${item.notes}\n${wasteNote}` : wasteNote;

      if (opts.fraction !== undefined && remaining > 0) {
        // Partial toss: decrement, keep the current state alive (directional —
        // self-heals at the next event). transitionInventory above has already
        // rejected terminal items.
        return this.store.updateItemState(item.ulid, {
          state: item.state,
          on_hand_fraction: remaining,
          notes,
        });
      }

      // Full toss (or the remainder hit zero): terminal. A counted item's
      // sealed remainder is tossed too — the whole item is gone.
      return this.store.updateItemState(item.ulid, {
        state: nextState,
        closed_at: at,
        on_hand_fraction: 0,
        ...(item.units_total != null ? { units_remaining: 0 } : {}),
        notes,
      });
    }

    // finished: terminal, zero the fraction (and, for a counted item, the
    // remaining units — a whole-item finish means none left), stamp closed_at.
    return this.store.updateItemState(item.ulid, {
      state: nextState,
      closed_at: at,
      on_hand_fraction: 0,
      ...(item.units_total != null ? { units_remaining: 0 } : {}),
    });
  }

  // ── Conversions (prep transforms) ────────────────────────────────────────────

  /**
   * A `convert` event: meal prep is a TRANSFORMATION, not consumption. Decrements
   * one or more source items (per each source's own count/fraction model — see
   * `applyConversionDecrement`) and creates a NEW derived item with its own
   * identity, shelf-life clock, quantity, and derived-from provenance (the
   * sources + optionally the recipe/conversion that fixes its macros). Distinct
   * from a consumption entry (this never touches kitchen.entries) and from
   * finished/tossed (those are terminal with no new item). The derived item is
   * first-class eat-first stock — it joins the ordinary eat-by ordering like any
   * other stocked item.
   *
   * Throws (plain Error, → 400 at the route) when a source is unknown, already
   * terminal, or supplied a non-integer amount against a counted item.
   */
  async convert(input: ConvertInput): Promise<ConvertResult> {
    if (!input.derived?.name?.trim()) {
      throw new ConversionValidationError('convert requires derived.name');
    }
    const at = parseDate(input.at);

    // `sources` is optional: a source-less conversion registers a prepared
    // item ("I made this") with empty provenance, decrementing nothing.
    const sourceRecords: InventoryItemRecord[] = [];
    const provenance: DerivationSource[] = [];
    for (const src of input.sources ?? []) {
      const item = await this.store.getItem(src.item_ulid);
      if (!item) throw new ConversionValidationError(`convert source item not found: ${src.item_ulid}`);
      if (isTerminal(item.state)) {
        throw new InvalidTransitionError(item.state, 'finished'); // a terminal item has nothing left to spend
      }
      const { updated, consumed, kind } = await this.applyConversionDecrement(item, src.amount, at);
      sourceRecords.push(updated);
      provenance.push({ item_ulid: item.ulid, amount: consumed, amount_kind: kind });
    }

    const derived = input.derived;
    const acquiredAt = parseDate(derived.acquired_at ?? input.at);
    const cls: ShelfLifeClass = derived.shelf_life_class ?? 'unknown';
    const eatBy = deriveEatBy({ shelfLifeClass: cls, acquiredAt, openedAt: null });
    const unitsTotal = derived.units_total ?? null;
    const { record: derivedRecord } = await this.store.insertItemIfAbsent({
      ulid: generateUlid(),
      product_ulid: null,
      raw_label: derived.name.trim(),
      store: derived.store ?? null,
      batch_ulid: null,
      state: 'stocked',
      on_hand_fraction: unitsTotal != null ? 1 : (derived.on_hand_fraction ?? 1),
      units_total: unitsTotal,
      units_remaining: unitsTotal,
      needs_info: false,
      acquired_at: acquiredAt,
      eat_by: eatBy,
      shelf_life_class: cls,
      notes: derived.notes ?? null,
    });

    const derivation = await this.store.insertDerivation({
      ulid: generateUlid(),
      derived_item_ulid: derivedRecord.ulid,
      sources: provenance,
      recipe_ulid: derived.recipe_ulid ?? null,
    });

    return {
      sources: await this.viewsOf(sourceRecords),
      derived: await this.viewOf(derivedRecord, { sources: provenance, recipe_ulid: derivation.recipe_ulid }),
      derivation,
    };
  }

  /**
   * Decrement one conversion source by `amount`, interpreted per the source's
   * OWN on-hand model: a counted item (units_total/units_remaining both set)
   * takes a whole-unit integer count; a fraction-modeled item takes a fraction
   * (0..1). Omitted `amount` fully consumes the source (all remaining units, or
   * the whole remaining fraction). Reaching zero goes terminal `finished`
   * (mirrors `finished-unit`/full-toss); otherwise the item stays alive with
   * the decremented quantity, state/opened_at/eat_by unchanged — spending SOME
   * of a source doesn't touch which unit (if any) is currently open. Returns
   * the updated record plus the normalized amount/kind actually recorded, for
   * the derivation's provenance.
   */
  private async applyConversionDecrement(
    item: InventoryItemRecord,
    amount: number | undefined,
    at: Date
  ): Promise<{ updated: InventoryItemRecord; consumed: number; kind: 'fraction' | 'count' }> {
    if (item.units_total != null && item.units_remaining != null) {
      const consume = amount === undefined ? item.units_remaining : amount;
      if (!Number.isInteger(consume) || consume < 1) {
        throw new ConversionValidationError(
          `convert source ${item.ulid} is counted — amount must be a whole-unit integer >= 1`
        );
      }
      const remaining = Math.max(0, item.units_remaining - consume);
      const updated =
        remaining === 0
          ? await this.store.updateItemState(item.ulid, {
              state: 'finished',
              closed_at: at,
              on_hand_fraction: 0,
              units_remaining: 0,
            })
          : await this.store.updateItemState(item.ulid, { state: item.state, units_remaining: remaining });
      return { updated: updated!, consumed: Math.min(consume, item.units_remaining), kind: 'count' };
    }

    const consume = clampFraction(amount === undefined ? item.on_hand_fraction : amount);
    const remaining = clampFraction(item.on_hand_fraction - consume);
    const updated =
      remaining <= 0
        ? await this.store.updateItemState(item.ulid, { state: 'finished', closed_at: at, on_hand_fraction: 0 })
        : await this.store.updateItemState(item.ulid, { state: item.state, on_hand_fraction: remaining });
    return { updated: updated!, consumed: consume, kind: 'fraction' };
  }

  // ── Consume from inventory (one-tap known-macro log + deplete) ──────────────

  /**
   * The atomic "eat a prepared item" action (claude-assist#110,
   * specs/modules/kitchen.md § Consume from inventory): for a
   * consume-eligible item, creates a consumption journal entry carrying the
   * item's EXACT known macros (no model call) and depletes the item, in ONE
   * atomic operation via `this.consumeStore` — a failure of either side
   * leaves NEITHER applied.
   *
   * Returns `null` when the item doesn't exist (→ 404 at the route). Throws:
   * - `InvalidTransitionError` — the item is already terminal (`409`).
   * - `ConsumeValidationError` — a bad `quantity`, or nothing on hand (`400`).
   * - `ConsumeIneligibleError` — the item carries no recipe-linked macro
   *   provenance, or that recipe can't be resolved / has no components (`400`).
   * - `ConsumeNotConfiguredError` — the module wasn't wired with a
   *   `consumeStore`/`resolveRecipe` (`503`).
   *
   * **Idempotency** (mirrors the entry-ingest ULID pattern): `input.ulid` is
   * the entry's client-generated ULID. A replay is detected BEFORE any
   * terminal/eligibility validation runs against the current item — this
   * matters because the first successful consume may have already driven
   * the item terminal (a fraction consume always fully finishes it), and a
   * replay must still succeed rather than 409 against its own side effect.
   * `this.consumeStore.consume()` itself also idempotency-checks inside the
   * same transaction, as a race-safety net for near-simultaneous replays.
   *
   * **Eligibility & macro inheritance**: an item qualifies only when its
   * derivation provenance (`derived_from.recipe_ulid`, set by a `convert`
   * event — see § Conversions) resolves to a recipe with at least one
   * component. The recipe's deterministic total macros
   * (`computeRecipeMacros`, no model call) are scaled by the SHARE of the
   * derived batch this consume spends: `quantity / units_total` for a
   * counted item (one jar out of N), or the item's current
   * `on_hand_fraction` for a fraction item (consuming finishes whatever
   * fraction of the batch remains). This is the only macro-inheritance
   * channel today — an item with no recipe-linked provenance has no
   * deterministically-known macros and is rejected, per the plan's
   * eligibility rule.
   *
   * **Depletion** mirrors `finished-unit` for a counted item (integer
   * decrement of `quantity` units; zero remaining goes terminal `finished`,
   * otherwise reverts to `stocked` with a fresh unopened `eat_by`) and
   * `finished` for a fraction item (always fully terminal — a fraction
   * consume is a single all-or-nothing tap, so `quantity` must be omitted or
   * `1` there).
   */
  async consume(itemUlid: string, input: ConsumeInput): Promise<ConsumeResult | null> {
    const item = await this.store.getItem(itemUlid);
    if (!item) return null;

    if (!this.consumeStore || !this.resolveRecipe) {
      throw new ConsumeNotConfiguredError();
    }

    // Idempotency short-circuit — see method doc. Checked before terminal/
    // eligibility validation so a replay of an already-fully-consumed item
    // succeeds instead of 409ing against the first attempt's own effect.
    const existingEntry = await this.consumeStore.peekEntry(input.ulid);
    if (existingEntry) {
      return { entry: existingEntry, item: await this.viewOf(item), created: false };
    }

    if (isTerminal(item.state)) {
      throw new InvalidTransitionError(item.state, 'finished');
    }

    const quantity = input.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new ConsumeValidationError('quantity must be a positive integer');
    }

    const at = parseDate(input.at);
    let itemUpdate: ItemStateUpdate;
    let share: number;

    if (item.units_total != null && item.units_remaining != null) {
      // Counted item: finished-unit semantics, generalized to `quantity` units.
      if (quantity > item.units_remaining) {
        throw new ConsumeValidationError(
          `quantity (${quantity}) exceeds units_remaining (${item.units_remaining}) for item ${itemUlid}`
        );
      }
      share = quantity / item.units_total;
      const remaining = item.units_remaining - quantity;
      itemUpdate =
        remaining === 0
          ? { state: 'finished', closed_at: at, on_hand_fraction: 0, units_remaining: 0 }
          : {
              state: 'stocked',
              opened_at: null,
              eat_by: deriveEatBy({ shelfLifeClass: item.shelf_life_class, acquiredAt: item.acquired_at, openedAt: null }),
              units_remaining: remaining,
            };
    } else {
      // Fraction item: finished semantics — a consume always fully finishes it.
      if (quantity !== 1) {
        throw new ConsumeValidationError(
          `item ${itemUlid} is fraction-modeled — consume always finishes it in one tap (quantity must be 1 or omitted)`
        );
      }
      if (item.on_hand_fraction <= 0) {
        throw new ConsumeValidationError(`item ${itemUlid} has nothing on hand to consume`);
      }
      share = item.on_hand_fraction;
      itemUpdate = { state: 'finished', closed_at: at, on_hand_fraction: 0 };
    }

    const derivedFrom = await this.derivedFromFor(item.ulid);
    const nutrition = scaleNutrition(await this.resolveConsumeMacros(item, derivedFrom), share);
    const loggedAt = input.at ? new Date(input.at) : new Date();

    const { entry, item: updatedItemRecord, created } = await this.consumeStore.consume(
      {
        ulid: input.ulid,
        logged_at: loggedAt,
        label: item.raw_label,
        nutrition,
        source: 'reselect',
        status: 'estimated',
        inventory_item_ulid: itemUlid,
      },
      itemUlid,
      itemUpdate
    );

    return {
      entry,
      item: await this.viewOf(updatedItemRecord, created ? derivedFrom : undefined),
      created,
    };
  }

  /**
   * Consume-eligibility + macro resolution (§ consume doc above). Throws
   * `ConsumeIneligibleError` when the item carries no usable recipe-linked
   * provenance — never returns a partial/guessed nutrition object.
   */
  private async resolveConsumeMacros(
    item: InventoryItemRecord,
    derivedFrom: DerivedFromView | null
  ): Promise<NutritionFields> {
    if (!derivedFrom?.recipe_ulid) {
      throw new ConsumeIneligibleError(
        item.ulid,
        'no known macros — not derived from a recipe-linked conversion (§ Consume from inventory eligibility rule)'
      );
    }
    const recipe = await this.resolveRecipe!(derivedFrom.recipe_ulid);
    if (!recipe || recipe.components.length === 0) {
      throw new ConsumeIneligibleError(
        item.ulid,
        `derivation recipe ${derivedFrom.recipe_ulid} not found or has no components`
      );
    }
    return computeRecipeMacros(recipe);
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

    try {
      // Same shared application as the explicit endpoint: a `tossed` fraction
      // is the amount tossed (partial toss decrements rather than terminates);
      // opened/finished ignore the parsed fraction.
      const fraction = parsed.type === 'tossed' ? parsed.fraction ?? undefined : undefined;
      const updated = await this.applyEventToRecord(best, parsed.type, { fraction, at });
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

  /**
   * Open needs_info items as one-time questions, **deduplicated by
   * `(store, normalized line_text)`**: a multi-quantity receipt line is one
   * question carrying the count + every covered item ulid. `limit` caps the
   * number of returned questions (groups). Items with a null raw_label are
   * never grouped together (each is its own question). Earliest-acquired first.
   */
  async listQuestions(limit = 50): Promise<InventoryQuestion[]> {
    // Fetch generously (store caps at 500); group, then cap groups by `limit`.
    const items = await this.store.listNeedsInfo(500);
    const groups = new Map<string, InventoryItemRecord[]>();
    const order: string[] = [];
    for (const i of items) {
      // Null raw_label → a unique key per item (never merged with anything).
      const key =
        i.raw_label != null
          ? `${i.store ?? ''}\x00${normalizeLine(i.raw_label)}`
          : `\x01${i.ulid}`;
      const bucket = groups.get(key);
      if (bucket) {
        bucket.push(i);
      } else {
        groups.set(key, [i]);
        order.push(key);
      }
    }
    // listNeedsInfo is already acquired_at-ascending, so each bucket's first
    // item is its earliest and `order` is earliest-group-first.
    const cap = Math.min(limit, order.length);
    const out: InventoryQuestion[] = [];
    for (let n = 0; n < cap; n++) {
      const bucket = groups.get(order[n]!)!;
      const rep = bucket[0]!;
      out.push({
        item_ulid: rep.ulid,
        item_ulids: bucket.map((i) => i.ulid),
        count: bucket.length,
        raw_label: rep.raw_label,
        store: rep.store,
        acquired_at: toIsoDate(rep.acquired_at)!,
        question: questionText(rep.raw_label, bucket.length),
      });
    }
    return out;
  }

  /**
   * Dismiss a non-grocery line (housewares etc.) to the terminal `dismissed`
   * state — removed from inventory without the food-waste semantics of a toss
   * (no waste note, on_hand_fraction untouched). Returns null if the item is
   * unknown; throws InvalidTransitionError (→ 409) on an already-terminal item.
   *
   * With `nonInventory`, additionally: (a) fan out to dismiss every open
   * needs_info sibling with the same `(store, normalized raw_label)`, and
   * (b) upsert a receipt_lexicon skip marker so future receipts skip the line.
   * Without it, only the single scanned item is dismissed.
   */
  async dismissItem(
    itemUlid: string,
    opts: { nonInventory?: boolean; at?: string } = {}
  ): Promise<DismissResolution | null> {
    const item = await this.store.getItem(itemUlid);
    if (!item) return null;
    const at = parseDate(opts.at);
    const nextState = transitionInventory(item.state, 'dismissed'); // throws on terminal
    const primary = await this.store.updateItemState(itemUlid, { state: nextState, closed_at: at });

    let dismissedCount = 1;
    const nonInventory = !!opts.nonInventory && !!item.store && !!item.raw_label;
    if (nonInventory && item.store && item.raw_label) {
      const siblings = await this.sameLineNeedsInfoSiblings(item.store, item.raw_label, itemUlid);
      for (const sib of siblings) {
        await this.store.updateItemState(sib.ulid, { state: 'dismissed', closed_at: at });
        dismissedCount += 1;
      }
      // Skip marker: future receipts carrying this line skip it (null product).
      await this.store.upsertLexicon({
        ulid: generateUlid(),
        store: item.store,
        line_text: normalizeLine(item.raw_label),
        product_ulid: null,
        package_size: null,
        shelf_life_class: null,
        non_inventory: true,
      });
    }

    return {
      item: await this.viewOf(primary ?? item),
      dismissed_count: dismissedCount,
      non_inventory: nonInventory,
    };
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
    // Sealed-unit count model: an explicit units_total makes this a counted
    // item (units_remaining starts full); omitted stays fraction-modeled.
    const unitsTotal = input.units_total ?? null;
    const newItem: NewItem = {
      ulid: input.ulid ?? generateUlid(),
      product_ulid: input.product_ulid ?? null,
      raw_label: input.raw_label ?? null,
      store: input.store ?? null,
      batch_ulid: input.batch_ulid ?? null,
      state: input.state ?? 'stocked',
      on_hand_fraction: input.on_hand_fraction ?? 1,
      units_total: unitsTotal,
      units_remaining: unitsTotal,
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
      ingredients: input.ingredients?.trim() || null,
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
    if (exact) return this.enrichProduct(exact, input);
    return this.createProduct(input);
  }

  /**
   * Merge parsed/explicit facts onto an existing product under the field
   * precedence explicit-meta/parsed > keep-existing (never null-clobbering).
   * `nutrition_per_100g` merges **per-field** so a later partial panel adds
   * fields without erasing earlier ones; `ingredients`/`package_size` keep the
   * existing value when the incoming is null; `shelf_life_class` only overrides
   * when the incoming class is not `unknown`; `aliases` union-merge. Shared by
   * the label resolve path (match-by-name) and the label enrich path
   * (already-linked item → enrich the linked product by ulid).
   */
  private async enrichProduct(existing: ProductRecord, input: ProductInput): Promise<ProductRecord> {
    const merged = await this.store.updateProduct(existing.ulid, {
      shelf_life_class:
        input.shelf_life_class && input.shelf_life_class !== 'unknown'
          ? input.shelf_life_class
          : existing.shelf_life_class,
      aliases: dedupeAliases([...existing.aliases, ...(input.aliases ?? [])]),
      nutrition_per_100g: mergeNutrition(existing.nutrition_per_100g, normalizeNutrition(input.nutrition_per_100g)),
      ingredients: (input.ingredients?.trim() || null) ?? existing.ingredients,
      package_size: input.package_size ?? existing.package_size,
    });
    return merged ?? existing;
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

  /**
   * `derivedFrom` may be pre-supplied by a caller that just wrote the
   * derivation row (the `convert` path) to skip a redundant read-after-write;
   * omitted, it's looked up (null for the common non-derived item).
   */
  private async viewOf(item: InventoryItemRecord, derivedFrom?: DerivedFromView | null): Promise<InventoryItemView> {
    const product = item.product_ulid ? await this.store.getProduct(item.product_ulid) : null;
    const resolved = derivedFrom !== undefined ? derivedFrom : await this.derivedFromFor(item.ulid);
    return toItemView(item, product?.name ?? null, new Date(), resolved);
  }

  private async viewsOf(items: InventoryItemRecord[]): Promise<InventoryItemView[]> {
    const products = await this.productMap(items);
    const derivations = await this.store.getDerivationsByDerivedItemUlids(items.map((i) => i.ulid));
    return items.map((i) =>
      toItemView(
        i,
        i.product_ulid ? products.get(i.product_ulid)?.name ?? null : null,
        new Date(),
        derivations.has(i.ulid) ? toDerivedFromView(derivations.get(i.ulid)!) : null
      )
    );
  }

  private async derivedFromFor(itemUlid: string): Promise<DerivedFromView | null> {
    const map = await this.store.getDerivationsByDerivedItemUlids([itemUlid]);
    const d = map.get(itemUlid);
    return d ? toDerivedFromView(d) : null;
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

/**
 * Normalize a receipt line for exact-string lexicon matching (upper +
 * collapse ws). Re-exported alias of the canonical `normalizeLexiconLine`
 * (inventory-derive.ts) — kept under this name for backward compatibility
 * with existing importers (index.ts's public re-export).
 */
export const normalizeLine = normalizeLexiconLine;

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

/**
 * Scale a deterministic macro total by the SHARE of it this consume spends
 * (§ consume from inventory doc above). `confidence`/`portion_basis` are
 * carried through unscaled — a recipe-computed total is exactly confidence
 * `1` regardless of what fraction of it one consume tap accounts for.
 */
export function scaleNutrition(total: NutritionFields, share: number): NutritionFields {
  const scale = (v: number | null): number | null => (v === null ? null : round1(v * share));
  return {
    calories: scale(total.calories),
    protein_g: scale(total.protein_g),
    fat_g: scale(total.fat_g),
    sat_fat_g: scale(total.sat_fat_g),
    carbs_g: scale(total.carbs_g),
    sodium_mg: scale(total.sodium_mg),
    confidence: total.confidence,
    portion_basis: total.portion_basis,
  };
}

/** Project a derivation row to the provenance shape embedded on the item view. */
function toDerivedFromView(d: InventoryDerivationRecord): DerivedFromView {
  return { sources: d.sources, recipe_ulid: d.recipe_ulid };
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

const NUTRITION_KEYS: (keyof NutritionPer100g)[] = [
  'calories',
  'protein_g',
  'fat_g',
  'sat_fat_g',
  'carbs_g',
  'sodium_mg',
  'fiber_g',
  'sugar_g',
];

function normalizeNutrition(input: Partial<NutritionPer100g> | null | undefined): NutritionPer100g | null {
  if (!input) return null;
  const out = {} as NutritionPer100g;
  let any = false;
  for (const k of NUTRITION_KEYS) {
    const v = input[k];
    out[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
    if (out[k] !== null) any = true;
  }
  return any ? out : null;
}

/**
 * Merge an incoming nutrition panel onto an existing one **per field**: a
 * non-null incoming value wins, otherwise the existing value is kept. This is
 * why a later scan that reads only `fiber_g` fills that field without erasing
 * the previously-banked `calories`/`protein_g`/etc. Returns the existing panel
 * when there is nothing to add, and the incoming when there was nothing before.
 */
export function mergeNutrition(
  existing: NutritionPer100g | null,
  incoming: NutritionPer100g | null
): NutritionPer100g | null {
  if (!incoming) return existing;
  if (!existing) return incoming;
  const out = {} as NutritionPer100g;
  for (const k of NUTRITION_KEYS) out[k] = incoming[k] ?? existing[k];
  return out;
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
    store_undetermined: b.store_undetermined,
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
    quantity: l.quantity,
    match_outcome: l.match_outcome,
    product_ulid: l.product_ulid,
    inventory_item_ulid: l.inventory_item_ulid,
    created_at: typeof l.created_at === 'string' ? l.created_at : l.created_at.toISOString(),
  };
}
