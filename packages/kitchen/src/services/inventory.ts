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
  ItemMergeResult,
  LabelResolution,
  LexiconInput,
  LexiconRecord,
  NutritionPer100g,
  ParsedLabel,
  ParsedReceiptLine,
  ProductInput,
  ProductMergeResult,
  ProductPatchInput,
  ProductRecord,
  PurchaseBatchRecord,
  PurchaseBatchView,
  ReceiptInput,
  ReconcileInput,
  ShelfLifeClass,
} from '../inventory-types.js';
import { CONVERT_SHELF_LIFE_CLASSES, PACKAGE_DURABLE_SHELF_LIFE_CLASSES } from '../inventory-types.js';
import type { NegligibleCandidate } from '../negligible-guard.js';
import { checkNegligible, negligibleRefusalMessage } from '../negligible-guard.js';
import type {
  ConversionSourceWrite,
  InventoryStore,
  ItemIdentityPatch,
  ItemStateUpdate,
  NewItem,
  NewProduct,
  ProductPatch,
} from '../inventory-store.js';
import { applyItemStateUpdate } from '../inventory-store.js';
import {
  deriveEatBy,
  normalizeLexiconLine,
  normalizeProductName,
  parsePackageCount,
  toItemView,
  toIsoDate,
} from '../inventory-derive.js';
import { InvalidTransitionError, isTerminal, transitionInventory } from '../inventory-state.js';
import { matchScore, parseRemark } from '../inventory-remark.js';
import { generateUlid } from '../ulid.js';
import type { ReceiptParser } from './receipt-parser.js';
import type { LabelParser } from './label-parser.js';
import { convertNetContent, derivePer100gFromServing } from './label-parser.js';
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
 * Thrown on a malformed product write (blank name, self-merge) — a 400 at the
 * route (specs/modules/kitchen.md § Product corrections).
 */
export class ProductValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductValidationError';
  }
}

/**
 * Thrown when a product write cannot be honored as asked — an ambiguous name
 * key, a rename into a live twin, a replace of an archived record, or a merge
 * into a retired one. A `409` at the route, never a silent near-miss: the
 * create-only `POST /products` used to strip an unknown `ulid`, mint a second
 * record, and answer `201`, which is indistinguishable from success
 * (§ Product corrections — "a write that cannot do what was asked says so").
 * The message always names the colliding ULIDs and the way forward.
 */
export class ProductConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductConflictError';
  }
}

/**
 * Thrown on a malformed item merge (a self-merge) — a 400 at the route
 * (specs/modules/kitchen.md § Item corrections).
 */
export class ItemValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemValidationError';
  }
}

/**
 * Thrown when an item merge cannot be honored as asked — a survivor that was
 * itself merged away, or a loser already merged into someone else. A `409` at
 * the route; the message always names where the record went so the caller can
 * retarget in one step (following a merge chain here would invite a cycle).
 */
export class ItemConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemConflictError';
  }
}

/** Thrown on an invalid reconcile (§ Reconcile — contradictory or ineligible correction) — a 400 at the route. */
export class ReconcileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconcileValidationError';
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
   * Move every consumption entry that depleted one item onto another, returning
   * how many moved — the entries half of an item merge (§ Item corrections).
   * Injected for the same reason `linkEntry` is: `kitchen.entries` belongs to the
   * phase-1 `EntryStore`, and the inventory pipeline stays entry-store-agnostic.
   * Absent, a merge reports `entries: 0` rather than claiming a move it did not
   * make.
   */
  relinkEntries?: (fromItemUlid: string, toItemUlid: string) => Promise<number>;
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
  /**
   * The item this entry has ALREADY depleted, when it has. Non-null means the
   * matcher must not run again (§ Depletion matcher — "one entry depletes at
   * most once"): the link column is the idempotency key, and an entry can reach
   * `estimated` more than once (a note/label PATCH re-queues estimation, and the
   * hook itself is best-effort/retryable).
   */
  inventory_item_ulid?: string | null;
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
  private relinkEntries?: (fromItemUlid: string, toItemUlid: string) => Promise<number>;
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
    this.relinkEntries = config.relinkEntries;
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
      // Printed grand total (§ Prices) — transcribed by the parse, informational
      // vs the lines' sum (tax/discounts make exact agreement rare).
      if (parsed.total_cents != null) {
        await this.store.setBatchTotal(batch.ulid, parsed.total_cents);
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
      await this.recordSkippedLine(batch, rawText, quantity, line.price_cents ?? null);
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
        price_cents: line.price_cents ?? null,
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
      await this.recordSkippedLine(batch, rawText, quantity, line.price_cents ?? null);
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
      price_cents: line.price_cents ?? null,
      match_outcome: 'unmatched',
      product_ulid: null,
      inventory_item_ulid: firstUlid,
    });
  }

  /** Record a batch line that stocks nothing (skipped), retaining the quantity + printed price. */
  private async recordSkippedLine(
    batch: PurchaseBatchRecord,
    rawText: string,
    quantity: number,
    priceCents: number | null = null
  ): Promise<void> {
    await this.store.insertLine({
      ulid: generateUlid(),
      batch_ulid: batch.ulid,
      raw_text: rawText,
      quantity,
      price_cents: priceCents,
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

    const parsed: ParsedLabel = photos.length > 0 && this.labelParser
      ? await this.labelParser.parse({ photos, hint: item.raw_label })
      : {
          name: null,
          shelf_life_class: null,
          package_size: null,
          serving_size_g: null,
          servings_per_container: null,
          nutrition_per_serving: null,
          nutrition_per_100g: null,
          ingredients: null,
          unit_model_hint: null,
          net_content: null,
          aliases: [] as string[],
        };

    const name = meta.name?.trim() || parsed.name || item.raw_label || 'Unlabeled item';
    const cls: ShelfLifeClass = meta.shelf_life_class ?? parsed.shelf_life_class ?? 'unknown';
    const packageSize = meta.package_size ?? parsed.package_size ?? null;
    const aliases = dedupeAliases([...(meta.aliases ?? []), ...parsed.aliases]);
    // Per-100g is DERIVED in code from the raw serving capture when possible
    // (§ Nutrition panel — capture raw, scale late); the model's transcribed
    // per-100g column is only the fallback for labels printed per-100g.
    const derived = derivePer100gFromServing(parsed.serving_size_g, parsed.nutrition_per_serving);
    const nutrition = normalizeNutrition(derived ?? parsed.nutrition_per_100g);
    // Net content (§ Prices' divisor): the model transcribed {value, unit};
    // code converts deterministically.
    const netContent = convertNetContent(parsed.net_content);
    const ingredients = meta.ingredients?.trim() || parsed.ingredients || null;
    const productInput: ProductInput & { name: string } = {
      name,
      shelf_life_class: cls,
      aliases,
      nutrition_per_100g: nutrition,
      serving_size_g: parsed.serving_size_g,
      nutrition_per_serving: normalizeNutrition(parsed.nutrition_per_serving),
      servings_per_container: parsed.servings_per_container,
      unit_model_hint: parsed.unit_model_hint,
      net_content_g: netContent.net_content_g,
      net_content_ml: netContent.net_content_ml,
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
      const eatBy = await this.eatByFromTruth(item, null);
      return this.store.updateItemState(item.ulid, {
        state: 'stocked',
        opened_at: null,
        eat_by: eatBy,
        units_remaining: remaining,
      });
    }

    const nextState = transitionInventory(item.state, type); // throws on terminal

    if (type === 'opened') {
      // The clock anchors to the EFFECTIVE opened date — the original
      // opened_at when one exists (a re-open is an idempotent no-op and must
      // not extend the window), else this event's date.
      const effectiveOpenedAt = item.opened_at ?? at;
      const eatBy = await this.eatByFromTruth(item, effectiveOpenedAt);
      const fraction = opts.fraction ?? item.on_hand_fraction;
      return this.store.updateItemState(item.ulid, {
        state: nextState,
        opened_at: effectiveOpenedAt,
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

  /**
   * Derive eat_by from the item's true state, folding in the linked product's
   * precise day-window overrides (label-derived) when one exists. Every path
   * that re-derives a clock (opened, finished-unit revert, reconcile) goes
   * through here so overrides are never silently dropped.
   */
  private async eatByFromTruth(item: InventoryItemRecord, openedAt: Date | null): Promise<Date | null> {
    const product = item.product_ulid ? await this.store.getProduct(item.product_ulid) : null;
    return deriveEatBy({
      shelfLifeClass: item.shelf_life_class,
      acquiredAt: item.acquired_at,
      openedAt,
      daysUnopenedOverride: product?.shelf_life_days_unopened ?? null,
      daysOpenedOverride: product?.shelf_life_days_opened ?? null,
    });
  }

  // ── Reconcile (§ Reconcile — corrections are observations, not events) ──────

  /**
   * Bring an item's ledger into line with observed reality: on-hand fraction,
   * unit counts, unit model (fraction ↔ counted), and state — WITHOUT firing
   * consumption-event semantics. A reconcile never advances or resets a clock:
   * `opened_at` changes only when explicitly supplied, or is cleared when the
   * corrected state is `stocked` (stocked MEANS sealed). `eat_by` always
   * re-derives from the corrected truth (product overrides included). An
   * explicit non-terminal `state` may resurrect a mis-closed item
   * (`closed_at` clears). Every reconcile appends a `reconciled <date>: …`
   * line to `notes` so corrections stay auditable as corrections.
   */
  async reconcileItem(itemUlid: string, input: ReconcileInput): Promise<InventoryItemView | null> {
    const item = await this.store.getItem(itemUlid);
    if (!item) return null;

    const hasAny =
      input.on_hand_fraction !== undefined ||
      input.units_total !== undefined ||
      input.units_remaining !== undefined ||
      input.state !== undefined ||
      input.opened_at !== undefined ||
      input.notes !== undefined;
    if (!hasAny) throw new ReconcileValidationError('reconcile needs at least one field');

    if (isTerminal(item.state) && input.state === undefined) {
      throw new ReconcileValidationError(
        `item is ${item.state} (terminal) — pass state: 'stocked'|'open' to resurrect it as part of the correction`
      );
    }
    const state: InventoryState = input.state ?? item.state;

    // ── Unit model: counted (units_total set), fraction (null), or unchanged ──
    let unitsTotal = item.units_total;
    let unitsRemaining = item.units_remaining;
    if (input.units_total !== undefined) {
      if (input.units_total === null) {
        if (input.units_remaining != null) {
          throw new ReconcileValidationError('units_total: null reverts to the fraction model — units_remaining must be omitted or null');
        }
        unitsTotal = null;
        unitsRemaining = null;
      } else {
        if (!Number.isInteger(input.units_total) || input.units_total < 1) {
          throw new ReconcileValidationError('units_total must be an integer >= 1 (or null to revert to fraction)');
        }
        unitsTotal = input.units_total;
        unitsRemaining = input.units_remaining !== undefined && input.units_remaining !== null
          ? input.units_remaining
          : (item.units_remaining ?? input.units_total);
      }
    } else if (input.units_remaining !== undefined) {
      if (item.units_total == null) throw new NotCountedItemError(item.ulid);
      if (input.units_remaining === null) {
        throw new ReconcileValidationError('units_remaining: null only accompanies units_total: null (fraction-model revert)');
      }
      unitsRemaining = input.units_remaining;
    }
    if (unitsTotal != null && unitsRemaining != null) {
      if (!Number.isInteger(unitsRemaining) || unitsRemaining < 1 || unitsRemaining > unitsTotal) {
        throw new ReconcileValidationError(
          `units_remaining must be an integer in 1..units_total (${unitsTotal}) — a zero count is a 'finished' event, not a correction`
        );
      }
    }

    // ── On-hand fraction: fraction-modeled items only ──
    let fraction = item.on_hand_fraction;
    if (input.on_hand_fraction !== undefined) {
      if (unitsTotal != null) {
        throw new ReconcileValidationError('on_hand_fraction applies to fraction-modeled items — recount a counted item via units_remaining');
      }
      if (!(input.on_hand_fraction > 0 && input.on_hand_fraction <= 1)) {
        throw new ReconcileValidationError("on_hand_fraction must be in (0, 1] — zero on hand is a 'finished'/'tossed' event, not a correction");
      }
      fraction = input.on_hand_fraction;
    }

    // ── Clock: never inferred. Explicit opened_at wins; a corrected `stocked`
    //    state clears it (stocked means sealed); otherwise unchanged. ──
    let openedAt = item.opened_at;
    if (input.opened_at !== undefined) {
      openedAt = input.opened_at === null ? null : parseDate(input.opened_at);
    }
    if (state === 'stocked') {
      if (input.opened_at != null) {
        throw new ReconcileValidationError("state 'stocked' means sealed — it cannot carry an opened_at");
      }
      openedAt = null;
    }
    if (state === 'open' && openedAt === null) {
      throw new ReconcileValidationError("state 'open' needs an opened_at — supply one (or it must already exist)");
    }

    const eatBy = await this.eatByFromTruth({ ...item, opened_at: openedAt }, openedAt);

    const changes: string[] = [];
    if (state !== item.state) changes.push(`state ${item.state}→${state}`);
    if (input.units_total !== undefined && unitsTotal !== item.units_total) {
      changes.push(unitsTotal === null ? 'reverted to fraction model' : `counted ${unitsRemaining}/${unitsTotal}`);
    } else if (unitsRemaining !== item.units_remaining) {
      changes.push(`units ${item.units_remaining}→${unitsRemaining}`);
    }
    if (fraction !== item.on_hand_fraction) changes.push(`fraction ${item.on_hand_fraction}→${fraction}`);
    if (toIsoDate(openedAt) !== toIsoDate(item.opened_at)) {
      changes.push(`opened_at ${toIsoDate(item.opened_at) ?? 'null'}→${toIsoDate(openedAt) ?? 'null'}`);
    }
    const summary = `reconciled ${toIsoDate(new Date())}: ${changes.length ? changes.join(', ') : 'no-op'}${input.notes ? ` — ${input.notes}` : ''}`;

    const updated = await this.store.updateItemState(item.ulid, {
      state,
      opened_at: openedAt,
      // Resurrecting a mis-closed item clears closed_at.
      ...(isTerminal(item.state) ? { closed_at: null } : {}),
      on_hand_fraction: fraction,
      units_total: unitsTotal,
      units_remaining: unitsRemaining,
      eat_by: eatBy,
      notes: item.notes ? `${item.notes}\n${summary}` : summary,
    });
    return updated ? this.viewOf(updated) : null;
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
   *
   * **Atomic** (§ Conversions § Atomicity): validation and decrement PLANNING
   * run first and write nothing, then every write — each source's decrement, the
   * derived item's insert, the derivation's insert — is applied as one unit by
   * `store.applyConversion`. A failure at any point leaves the ledger exactly as
   * it was; in particular there is no window in which the sources are spent and
   * the derived item was never created.
   */
  async convert(input: ConvertInput): Promise<ConvertResult> {
    if (!input.derived?.name?.trim()) {
      throw new ConversionValidationError('convert requires derived.name');
    }

    // A convert output is a made (homemade) item, never a sealed store package.
    // Reject the package-durable classes up front — before any source is
    // decremented or item created — so a homemade dish can't be saddled with a
    // sealed-package "unopened" clock (§ Shelf-life classes — made-food-only
    // guard). Made-food classes and an omitted class (→ `prepared`) pass.
    const requestedClass = input.derived.shelf_life_class;
    if (requestedClass !== undefined && PACKAGE_DURABLE_SHELF_LIFE_CLASSES.includes(requestedClass)) {
      throw new ConversionValidationError(
        `convert derived.shelf_life_class '${requestedClass}' is a package-durable class; a converted (made) item accepts only made-food classes: ${CONVERT_SHELF_LIFE_CLASSES.join(', ')} (default 'prepared')`
      );
    }

    const at = parseDate(input.at);

    // `sources` is optional: a source-less conversion registers a prepared
    // item ("I made this") with empty provenance, decrementing nothing.
    //
    // This loop only VALIDATES and PLANS — nothing is written until
    // `store.applyConversion` below, so a rejected source (unknown, terminal,
    // bad amount) can't leave an earlier source already spent.
    const sourceWrites: ConversionSourceWrite[] = [];
    const provenance: DerivationSource[] = [];
    // A source may legitimately appear twice in one conversion (spend two units
    // of the same pack into two provenance lines). Each plan must see the
    // PROJECTED state its predecessors leave behind, exactly as the old
    // write-as-you-go loop's re-read did, so the second occurrence decrements
    // the remainder rather than recomputing from the original quantity.
    const projected = new Map<string, InventoryItemRecord>();
    for (const src of input.sources ?? []) {
      const item = projected.get(src.item_ulid) ?? (await this.store.getItem(src.item_ulid));
      if (!item) throw new ConversionValidationError(`convert source item not found: ${src.item_ulid}`);
      if (isTerminal(item.state)) {
        throw new InvalidTransitionError(item.state, 'finished'); // a terminal item has nothing left to spend
      }
      const { update, consumed, kind } = this.planConversionDecrement(item, src.amount, at);
      sourceWrites.push({ item_ulid: item.ulid, update });
      projected.set(item.ulid, applyItemStateUpdate(item, update));
      provenance.push({ item_ulid: item.ulid, amount: consumed, amount_kind: kind });
    }

    const derived = input.derived;
    const acquiredAt = parseDate(derived.acquired_at ?? input.at);
    // A convert output is a prepared dish: default it to the `prepared` class
    // (~4 days from the make date) so it always earns an eat-by and joins
    // eat-first ordering, rather than falling to `unknown` (no eat-by). A
    // caller that knows the dish keeps longer/shorter overrides it.
    const cls: ShelfLifeClass = derived.shelf_life_class ?? 'prepared';
    const eatBy = deriveEatBy({ shelfLifeClass: cls, acquiredAt, openedAt: null });
    const unitsTotal = derived.units_total ?? null;
    const derivedUlid = generateUlid();

    // ONE atomic write for all three phases (§ Conversions § Atomicity).
    const {
      sources: sourceRecords,
      derived: derivedRecord,
      derivation,
    } = await this.store.applyConversion({
      sources: sourceWrites,
      derived: {
        ulid: derivedUlid,
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
      },
      derivation: {
        ulid: generateUlid(),
        derived_item_ulid: derivedUlid,
        sources: provenance,
        recipe_ulid: derived.recipe_ulid ?? null,
      },
    });

    return {
      sources: await this.viewsOf(sourceRecords),
      derived: await this.viewOf(derivedRecord, { sources: provenance, recipe_ulid: derivation.recipe_ulid }),
      derivation,
    };
  }

  /**
   * Plan (do NOT apply) one conversion source's decrement by `amount`,
   * interpreted per the source's OWN on-hand model: a counted item
   * (units_total/units_remaining both set) takes a whole-unit integer count; a
   * fraction-modeled item takes a fraction (0..1). Omitted `amount` fully
   * consumes the source (all remaining units, or the whole remaining fraction).
   * Reaching zero goes terminal `finished` (mirrors `finished-unit`/full-toss);
   * otherwise the item stays alive with the decremented quantity,
   * state/opened_at/eat_by unchanged — spending SOME of a source doesn't touch
   * which unit (if any) is currently open. Returns the update to apply plus the
   * normalized amount/kind actually recorded, for the derivation's provenance.
   *
   * Pure and synchronous by design: the whole point is that the amount validation
   * (a non-integer count against a counted source) happens with nothing yet
   * written, so `convert` can hand every planned write to `applyConversion` at
   * once (§ Conversions § Atomicity).
   */
  private planConversionDecrement(
    item: InventoryItemRecord,
    amount: number | undefined,
    at: Date
  ): { update: ItemStateUpdate; consumed: number; kind: 'fraction' | 'count' } {
    if (item.units_total != null && item.units_remaining != null) {
      const consume = amount === undefined ? item.units_remaining : amount;
      if (!Number.isInteger(consume) || consume < 1) {
        throw new ConversionValidationError(
          `convert source ${item.ulid} is counted — amount must be a whole-unit integer >= 1`
        );
      }
      const remaining = Math.max(0, item.units_remaining - consume);
      const update: ItemStateUpdate =
        remaining === 0
          ? { state: 'finished', closed_at: at, on_hand_fraction: 0, units_remaining: 0 }
          : { state: item.state, units_remaining: remaining };
      return { update, consumed: Math.min(consume, item.units_remaining), kind: 'count' };
    }

    const consume = clampFraction(amount === undefined ? item.on_hand_fraction : amount);
    const remaining = clampFraction(item.on_hand_fraction - consume);
    const update: ItemStateUpdate =
      remaining <= 0
        ? { state: 'finished', closed_at: at, on_hand_fraction: 0 }
        : { state: item.state, on_hand_fraction: remaining };
    return { update, consumed: consume, kind: 'fraction' };
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
   * component. What the recipe DESCRIBES depends on the item's unit model
   * (§ Consume — the per-unit recipe contract): for a **counted** item the
   * recipe describes ONE sealed unit (the system-wide per-serving recipe
   * convention), so the logged macros are `recipe × quantity`; for a
   * **fraction** item it describes the whole batch, scaled by the item's
   * current `on_hand_fraction` (consuming finishes whatever fraction
   * remains). This is the only macro-inheritance channel today — an item
   * with no recipe-linked provenance has no deterministically-known macros
   * and is rejected, per the plan's eligibility rule.
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
      // The linked recipe describes ONE sealed unit of a counted item (the
      // system-wide per-serving recipe convention — the reselect strip logs
      // the same recipe whole), so N units = N × the recipe, never a share of
      // it. The 2026-07-22 oat-jar incident: a per-jar recipe on a 3-jar
      // batch logged ⅓ of a jar under the old whole-item division.
      share = quantity;
      const remaining = item.units_remaining - quantity;
      itemUpdate =
        remaining === 0
          ? { state: 'finished', closed_at: at, on_hand_fraction: 0, units_remaining: 0 }
          : {
              state: 'stocked',
              opened_at: null,
              eat_by: await this.eatByFromTruth(item, null),
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
      if (parsed.type === 'recount') {
        // A pure quantity observation routes to § Reconcile — a correction,
        // not a consumption event; no clock is touched.
        const item = await this.reconcileItem(best.ulid, { on_hand_fraction: parsed.fraction ?? undefined });
        return {
          matched: true,
          item: item ?? undefined,
          event: { type: 'recount', fraction: parsed.fraction },
        };
      }
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
      // Terminal item matched (already finished/tossed), or the recount was
      // invalid for the matched item (e.g. counted model) — treat as unmatched.
      return { matched: false };
    }
  }

  // ── Depletion matcher (consumption → inventory) ──────────────────────────────

  /**
   * After a consumption entry reaches terminal `estimated`, conservatively
   * match its label against on-hand items and decrement the single best match,
   * linking the entry. Ambiguous/absent match = no-op. No model call.
   *
   * The decrement follows the matched item's OWN unit model
   * (specs/modules/kitchen.md § Depletion matcher):
   *
   * - **counted item** — one whole sealed unit off `units_remaining`, with
   *   `finished-unit` semantics (terminal `finished` at zero, otherwise back to
   *   `stocked` on the unopened clock). One matched entry is one serving is one
   *   unit, matching the per-serving convention § Consume from inventory uses.
   * - **fraction item** — the fixed directional step off `on_hand_fraction`.
   *
   * Stepping a COUNTED item's fraction (what this did for every item) is a
   * silent no-op: nothing reads that field on a counted item, so the count sat
   * at its purchase value while the shelf emptied — every consumption logged in
   * the journal, none of it in the ledger. Counting exists to be the exact
   * alternative to an eyeballed fraction, so a count that never moves is worse
   * than a fraction: unlike a fraction, it doesn't look like a guess.
   */
  async matchAndDeplete(entry: DepletableEntry): Promise<InventoryItemView | null> {
    if (entry.status !== 'estimated' || !entry.label) return null;
    // Already depleted something — never take a second unit off the shelf for
    // one meal (§ Depletion matcher, "one entry depletes at most once").
    if (entry.inventory_item_ulid) return null;
    const onHand = await this.store.listItems({ states: ['stocked', 'open'], limit: 500 });
    const products = await this.productMap(onHand);
    const best = this.bestItemMatch(entry.label, onHand, products, 2 /* conservative */);
    if (!best) return null;

    let updated: InventoryItemRecord | null;
    if (best.units_total != null && best.units_remaining != null) {
      try {
        updated = await this.applyEventToRecord(best, 'finished-unit', {});
      } catch (err) {
        // Best-effort per the module's directional-inventory principle: a
        // depletion that can't apply must never affect the entry.
        this.log.warn({ err, entry: entry.ulid, item: best.ulid }, 'Counted depletion could not be applied');
        return null;
      }
    } else {
      const next = clampFraction(best.on_hand_fraction - this.depletionStep);
      updated = await this.store.setItemFraction(best.ulid, next);
    }
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

  /**
   * `POST /inventory/:ulid/merge` — fold a duplicate item into a survivor
   * (§ Item corrections). Dismissal alone is the wrong tool for a duplicate: the
   * losing row is what a consumption entry, a receipt line, and a conversion
   * already point at, so retiring it without moving them strands history against
   * a record that is no longer stock.
   *
   * Four steps, in this order:
   *
   * 1. **Fill the survivor's gaps** — only the five identity fields, only where
   *    the survivor's own value is null. This is the only door that can move
   *    `product_ulid` onto an item at all, which is what makes merge the
   *    correction for a `needs_info` row whose identity was established on the
   *    other record.
   * 2. **Resolve the survivor** when the fill identified it: `needs_info` clears
   *    and `eat_by` re-derives from the SURVIVOR's own clock — never the
   *    loser's, since a duplicate minted a day late reads as a day fresher than
   *    the food is, and that misreport is the whole defect.
   * 3. **Relink every dependent** (entries via the injected hook; batch lines and
   *    both derivation links in the store).
   * 4. **Retire the loser** as `dismissed` with `merged_into`.
   *
   * Quantities are never summed — the merge asserts these two rows are ONE
   * physical package, so adding them would manufacture the very over-reporting
   * the duplicate caused. A wrong count is a separate observation (`recount`).
   *
   * Idempotent: a replay into the same survivor relinks nothing and keeps the
   * first retirement stamp. Null when either ULID is unknown.
   */
  async mergeItems(loserUlid: string, survivorUlid: string): Promise<ItemMergeResult | null> {
    if (loserUlid === survivorUlid) {
      throw new ItemValidationError('into must differ from the item being merged');
    }
    const loser = await this.store.getItem(loserUlid);
    const survivor = await this.store.getItem(survivorUlid);
    if (!loser || !survivor) return null;

    if (survivor.merged_into) {
      throw new ItemConflictError(
        `Merge target ${survivor.ulid} was itself merged into ${survivor.merged_into} — merging into a retired record would bury the data twice. Retarget the survivor.`
      );
    }
    if (loser.merged_into && loser.merged_into !== survivorUlid) {
      throw new ItemConflictError(
        `Item ${loser.ulid} was already merged into ${loser.merged_into}, not ${survivorUlid}.`
      );
    }

    // 1. Gap fill — never overwrite a value the survivor already has.
    const fill: ItemIdentityPatch = {};
    if (survivor.product_ulid === null && loser.product_ulid !== null) fill.product_ulid = loser.product_ulid;
    if (survivor.raw_label === null && loser.raw_label !== null) fill.raw_label = loser.raw_label;
    if (survivor.store === null && loser.store !== null) fill.store = loser.store;
    if (survivor.batch_ulid === null && loser.batch_ulid !== null) fill.batch_ulid = loser.batch_ulid;
    if (survivor.shelf_life_class === null && loser.shelf_life_class !== null) {
      fill.shelf_life_class = loser.shelf_life_class;
    }
    let merged =
      Object.keys(fill).length > 0
        ? (await this.store.updateItemIdentity(survivorUlid, fill)) ?? survivor
        : survivor;

    // 2. A gained product identity resolves the survivor, on ITS OWN clock.
    if (fill.product_ulid && merged.needs_info) {
      const product = await this.store.getProduct(fill.product_ulid);
      const cls = merged.shelf_life_class ?? product?.shelf_life_class ?? 'unknown';
      const eatBy = deriveEatBy({
        shelfLifeClass: cls,
        acquiredAt: merged.acquired_at,
        openedAt: merged.opened_at,
        daysUnopenedOverride: product?.shelf_life_days_unopened,
        daysOpenedOverride: product?.shelf_life_days_opened,
      });
      merged =
        (await this.store.resolveNeedsInfo(survivorUlid, {
          product_ulid: fill.product_ulid,
          shelf_life_class: cls,
          eat_by: eatBy,
        })) ?? merged;
    }

    // 3. Relink. Entries cross a store seam (see `relinkEntries`), so an
    //    unwired pipeline reports 0 rather than claiming a move it didn't make.
    const counts = await this.store.relinkItemReferences(loserUlid, survivorUlid);
    let entries = 0;
    if (this.relinkEntries) {
      entries = await this.relinkEntries(loserUlid, survivorUlid);
    }

    // 4. Retire.
    const retired = await this.store.retireMergedItem(loserUlid, survivorUlid, new Date());

    return {
      item: await this.viewOf(merged),
      merged: await this.viewOf(retired ?? loser),
      relinked: { entries, ...counts },
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
    return this.store.insertProduct({ ulid: generateUlid(), ...productFields(input) });
  }

  /**
   * `POST /products` — a real upsert (specs/modules/kitchen.md § Product
   * corrections). Two branches:
   *
   * - **explicit `ulid`** → create-or-replace that exact record. A replace
   *   **states the whole record**: omitted fields revert to their defaults, so
   *   this is the only way to clear one. An explicit key is explicit intent, so
   *   it deliberately bypasses the name-key checks below — otherwise the escape
   *   hatch for correcting one of two same-named duplicates would be blocked by
   *   the very collision it exists to resolve. An archived target is refused
   *   rather than resurrected.
   * - **no `ulid`** → the normalized name is the key, resolved against LIVE
   *   products: no match creates, exactly one match **enriches** in place, more
   *   than one throws `ProductConflictError` naming every candidate.
   *
   * The name key enriches rather than replacing because a product is an
   * accretion several writers build (receipt seed, label scan, owner
   * correction): replacing would let a bare `{name}` re-seed erase a scanned
   * nutrition panel — a write destroying data it never mentioned.
   *
   * `created` distinguishes insert from replace/enrich so the route can answer
   * `201` vs `200`.
   */
  async upsertProduct(input: ProductInput & { ulid?: string }): Promise<{ product: ProductRecord; created: boolean }> {
    const name = input.name.trim();
    if (!name) throw new ProductValidationError('name must not be blank');
    const normalizedInput: ProductInput = { ...input, name };

    if (input.ulid) {
      const existing = await this.store.getProduct(input.ulid);
      if (existing?.archived_at) {
        throw new ProductConflictError(
          `Product ${existing.ulid} is archived and cannot be replaced${
            existing.merged_into ? ` — it was merged into ${existing.merged_into}` : ''
          }. Post to the surviving record, or use a new ulid.`
        );
      }
      // A replace STATES the whole record, so the guard judges the body's own
      // facts — not whatever panel the record used to carry.
      guardNegligible(candidateOfInput(normalizedInput), {
        asserting: normalizedInput.nutrition_negligible === true,
        override: input.nutrition_negligible_override,
      });
      if (existing) {
        const replaced = await this.store.updateProduct(input.ulid, productFields(normalizedInput));
        // Vanished between read and write — fall through to a create rather
        // than reporting a replace that didn't happen.
        if (replaced) return { product: replaced, created: false };
      }
      return { product: await this.store.insertProduct({ ulid: input.ulid, ...productFields(normalizedInput) }), created: true };
    }

    const matches = await this.store.findLiveProductsByNormalizedName(normalizeProductName(name));
    if (matches.length > 1) {
      throw new ProductConflictError(
        `Product name "${name}" already belongs to ${matches.map((p) => p.ulid).join(', ')}. ` +
          'Pass an explicit ulid to enrich a specific record, or merge the duplicates ' +
          '(POST /products/:ulid/merge {"into": "<survivor>"}).'
      );
    }
    const existing = matches[0];
    if (existing) {
      // An enrich never null-clobbers, so the resulting product is the merge of
      // both — and that merge is what the assertion would be made about.
      guardNegligible(candidateOfEnrich(existing, normalizedInput), {
        asserting: normalizedInput.nutrition_negligible === true,
        override: input.nutrition_negligible_override,
      });
      return { product: await this.enrichProduct(existing, normalizedInput), created: false };
    }
    guardNegligible(candidateOfInput(normalizedInput), {
      asserting: normalizedInput.nutrition_negligible === true,
      override: input.nutrition_negligible_override,
    });
    return { product: await this.createProduct(normalizedInput), created: true };
  }

  /**
   * `PATCH /products/:ulid` — the correction door (§ Product corrections).
   * Partial: only the keys present in `patch` change. An explicit `null`
   * **clears** a nullable field, which is where this differs from every enrich
   * path in the module — an enrich merges a guess that may simply not have read
   * a field, while a patch body is the owner stating what is true.
   *
   * Both nutrition panels merge **per-field**, so filling one missing field
   * never requires restating the other eight; `nutrition_per_100g: null` clears
   * the whole panel.
   *
   * `name` is patchable — a product's identity is its ULID (items, lexicon
   * lines, and batch lines all link by `product_ulid`), and receipt-derived
   * names badly need correcting. The one guard: a rename that *changes* the
   * normalized name into a live twin's throws `ProductConflictError`, since it
   * would manufacture the duplicate the merge path exists to remove. Restating
   * the name it already has is never a collision.
   *
   * Null for an unknown ULID (a `404` at the route).
   */
  async patchProduct(ulid: string, patch: ProductPatchInput): Promise<ProductRecord | null> {
    const existing = await this.store.getProduct(ulid);
    if (!existing) return null;

    const out: ProductPatch = {};

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new ProductValidationError('name must not be blank');
      const normalized = normalizeProductName(name);
      if (normalized !== normalizeProductName(existing.name)) {
        const twins = (await this.store.findLiveProductsByNormalizedName(normalized)).filter((p) => p.ulid !== ulid);
        if (twins.length > 0) {
          throw new ProductConflictError(
            `Product name "${name}" already belongs to ${twins.map((p) => p.ulid).join(', ')}. ` +
              'Pick a distinct name, or merge into it (POST /products/:ulid/merge {"into": "<survivor>"}).'
          );
        }
      }
      out.name = name;
    }

    if (patch.shelf_life_class !== undefined) out.shelf_life_class = patch.shelf_life_class;
    if (patch.aliases !== undefined) out.aliases = dedupeAliases(patch.aliases);
    if (patch.serving_size_g !== undefined) out.serving_size_g = patch.serving_size_g;
    if (patch.servings_per_container !== undefined) out.servings_per_container = patch.servings_per_container;
    if (patch.unit_model_hint !== undefined) out.unit_model_hint = patch.unit_model_hint;
    if (patch.net_content_g !== undefined) out.net_content_g = patch.net_content_g;
    if (patch.net_content_ml !== undefined) out.net_content_ml = patch.net_content_ml;
    if (patch.package_size !== undefined) out.package_size = patch.package_size;
    if (patch.shelf_life_days_unopened !== undefined) out.shelf_life_days_unopened = patch.shelf_life_days_unopened;
    if (patch.shelf_life_days_opened !== undefined) out.shelf_life_days_opened = patch.shelf_life_days_opened;
    if (patch.nutrition_negligible !== undefined) out.nutrition_negligible = patch.nutrition_negligible;
    if (patch.ingredients !== undefined) out.ingredients = patch.ingredients?.trim() || null;
    if (patch.nutrition_per_100g !== undefined) {
      out.nutrition_per_100g = patchPanel(existing.nutrition_per_100g, patch.nutrition_per_100g);
    }
    if (patch.nutrition_per_serving !== undefined) {
      out.nutrition_per_serving = patchPanel(existing.nutrition_per_serving, patch.nutrition_per_serving);
    }

    // `nutrition_negligible_override` is an instruction, not a fact, so a body
    // carrying only it passes the schema's `minProperties` while changing
    // nothing. The contract is "at least one key that changes something".
    if (Object.keys(out).length === 0) {
      throw new ProductValidationError('patch body states no field to change');
    }

    guardNegligible(
      {
        name: out.name ?? existing.name,
        aliases: [...(out.aliases ?? existing.aliases), ...(out.name ? [existing.name] : [])],
        ingredients: out.ingredients !== undefined ? out.ingredients : existing.ingredients,
        nutrition_per_100g:
          out.nutrition_per_100g !== undefined ? out.nutrition_per_100g : existing.nutrition_per_100g,
        nutrition_per_serving:
          out.nutrition_per_serving !== undefined ? out.nutrition_per_serving : existing.nutrition_per_serving,
        serving_size_g: out.serving_size_g !== undefined ? out.serving_size_g : existing.serving_size_g,
      },
      {
        // Two ways a patch asserts, both conditioned on the product ending up
        // marked: it states the marker, or it RENAMES a product that stays
        // marked — "garlic powder" → "garlic salt" is a new claim about a
        // different food wearing an old record's marker. A rename that unmarks
        // in the same body asserts nothing and is never refused.
        asserting:
          (out.nutrition_negligible ?? existing.nutrition_negligible) &&
          (patch.nutrition_negligible === true || (out.name !== undefined && out.name !== existing.name)),
        override: patch.nutrition_negligible_override,
      }
    );

    return this.store.updateProduct(ulid, out);
  }

  /**
   * `POST /products/:ulid/merge` — fold a duplicate into a survivor
   * (§ Product corrections). A plain delete is the wrong tool: the losing
   * record is what inventory items, lexicon lines, and batch lines already
   * point at, so removing it orphans live rows and throws away the mapping work
   * the lexicon represents. So: enrich the survivor from the loser (never
   * null-clobbering — the survivor's own values win, the loser fills the gaps),
   * relink every dependent, then archive the loser with `merged_into` set.
   *
   * Idempotent — re-merging an already-merged loser into the same survivor
   * succeeds with zero relinks. Null when either ULID is unknown.
   */
  async mergeProducts(loserUlid: string, survivorUlid: string): Promise<ProductMergeResult | null> {
    if (loserUlid === survivorUlid) {
      throw new ProductValidationError('into must differ from the product being merged');
    }
    const loser = await this.store.getProduct(loserUlid);
    const survivor = await this.store.getProduct(survivorUlid);
    if (!loser || !survivor) return null;

    if (survivor.archived_at) {
      throw new ProductConflictError(
        `Merge target ${survivor.ulid} is archived${
          survivor.merged_into ? ` (merged into ${survivor.merged_into})` : ''
        } — merging into a retired record would bury the data twice. Retarget the survivor.`
      );
    }
    if (loser.merged_into && loser.merged_into !== survivorUlid) {
      throw new ProductConflictError(
        `Product ${loser.ulid} was already merged into ${loser.merged_into}, not ${survivorUlid}.`
      );
    }

    const enriched = await this.enrichProduct(survivor, {
      name: survivor.name,
      shelf_life_class: loser.shelf_life_class,
      aliases: [...loser.aliases, loser.name],
      nutrition_per_100g: loser.nutrition_per_100g,
      serving_size_g: loser.serving_size_g,
      nutrition_per_serving: loser.nutrition_per_serving,
      servings_per_container: loser.servings_per_container,
      unit_model_hint: loser.unit_model_hint,
      net_content_g: loser.net_content_g,
      net_content_ml: loser.net_content_ml,
      ingredients: loser.ingredients,
      package_size: loser.package_size,
      nutrition_negligible: loser.nutrition_negligible,
    });
    const relinked = await this.store.relinkProductReferences(loserUlid, survivorUlid);
    const merged = await this.store.archiveProduct(loserUlid, survivorUlid);

    return { product: enriched, merged: merged ?? loser, relinked };
  }

  /**
   * `DELETE /products/:ulid` — **archive**, never destroy (§ Product
   * corrections). An archived product leaves every listing and stops being a
   * name-match candidate, but stays resolvable by ULID so a linked item still
   * renders its name and derives its shelf life. Idempotent; null for an
   * unknown ULID.
   */
  async archiveProduct(ulid: string): Promise<ProductRecord | null> {
    return this.store.archiveProduct(ulid);
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
      serving_size_g: input.serving_size_g ?? existing.serving_size_g,
      nutrition_per_serving: mergeNutrition(
        existing.nutrition_per_serving,
        normalizeNutrition(input.nutrition_per_serving)
      ),
      servings_per_container: input.servings_per_container ?? existing.servings_per_container,
      unit_model_hint: input.unit_model_hint ?? existing.unit_model_hint,
      net_content_g: input.net_content_g ?? existing.net_content_g,
      net_content_ml: input.net_content_ml ?? existing.net_content_ml,
      ingredients: (input.ingredients?.trim() || null) ?? existing.ingredients,
      package_size: input.package_size ?? existing.package_size,
      // Never un-marks: an enrich carries no evidence AGAINST negligibility
      // (§ Nutritionally negligible products — the marker is cleared only by an
      // explicit PATCH).
      nutrition_negligible: existing.nutrition_negligible || (input.nutrition_negligible ?? false),
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
    return toItemView(item, product, new Date(), resolved);
  }

  private async viewsOf(items: InventoryItemRecord[]): Promise<InventoryItemView[]> {
    const products = await this.productMap(items);
    const derivations = await this.store.getDerivationsByDerivedItemUlids(items.map((i) => i.ulid));
    return items.map((i) =>
      toItemView(
        i,
        i.product_ulid ? products.get(i.product_ulid) ?? null : null,
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
    sugar_g: scale(total.sugar_g),
    added_sugar_g: scale(total.added_sugar_g),
    fiber_g: scale(total.fiber_g),
    sodium_mg: scale(total.sodium_mg),
    confidence: total.confidence,
    portion_basis: total.portion_basis,
  };
}

/** Project a derivation row to the provenance shape embedded on the item view. */
function toDerivedFromView(d: InventoryDerivationRecord): DerivedFromView {
  return { sources: d.sources, recipe_ulid: d.recipe_ulid };
}

/**
 * The full stored fact set for a product, defaults filled — used by both an
 * insert and an explicit-ulid **replace** (§ Product corrections), which is why
 * every omitted field lands on its default rather than being skipped: a replace
 * states the whole record, and that is the only way a caller can clear a field.
 */
function productFields(input: ProductInput): Omit<NewProduct, 'ulid'> {
  return {
    name: input.name.trim(),
    shelf_life_class: input.shelf_life_class ?? 'unknown',
    aliases: dedupeAliases(input.aliases ?? []),
    nutrition_per_100g: normalizeNutrition(input.nutrition_per_100g),
    serving_size_g: input.serving_size_g ?? null,
    nutrition_per_serving: normalizeNutrition(input.nutrition_per_serving),
    servings_per_container: input.servings_per_container ?? null,
    unit_model_hint: input.unit_model_hint ?? null,
    net_content_g: input.net_content_g ?? null,
    net_content_ml: input.net_content_ml ?? null,
    ingredients: input.ingredients?.trim() || null,
    package_size: input.package_size ?? null,
    shelf_life_days_unopened: input.shelf_life_days_unopened ?? null,
    shelf_life_days_opened: input.shelf_life_days_opened ?? null,
    nutrition_negligible: input.nutrition_negligible ?? false,
  };
}

/**
 * Refuse a `nutrition_negligible` assertion the sodium guard rejects
 * (§ Nutritionally negligible products — § Sodium is the exception that breaks
 * the marker). A `ProductValidationError`, so the route answers `400` with the
 * refusal's evidence and the override to pass.
 *
 * **The guard fires only when the request ASSERTS the marker** — an explicit
 * `nutrition_negligible: true` in the body (plus the one rename case
 * `patchProduct` spells out). Silence is not an assertion, which is what keeps
 * the machine paths clear: a receipt seed or a label enrich landing on a marked
 * product says nothing about negligibility and is never blocked by this. The
 * cost of that choice is that a product marked before this guard existed keeps
 * its marker until someone re-states it — and when they do, the refusal is how
 * the pre-existing mismark surfaces.
 */
function guardNegligible(
  candidate: NegligibleCandidate,
  opts: { asserting: boolean; override?: boolean }
): void {
  if (!opts.asserting || opts.override === true) return;
  const refusal = checkNegligible(candidate);
  if (refusal) throw new ProductValidationError(negligibleRefusalMessage(candidate.name, refusal));
}

/** The guard's view of a body that states the whole record (create / replace). */
function candidateOfInput(input: ProductInput): NegligibleCandidate {
  return {
    name: input.name,
    aliases: input.aliases ?? null,
    ingredients: input.ingredients ?? null,
    nutrition_per_100g: input.nutrition_per_100g ?? null,
    nutrition_per_serving: input.nutrition_per_serving ?? null,
    serving_size_g: input.serving_size_g ?? null,
  };
}

/**
 * The guard's view of a name-key enrich: the merge `enrichProduct` is about to
 * write, under the same never-null-clobbering precedence. The stored name is
 * kept (an enrich doesn't rename) and the incoming spelling joins the aliases,
 * so a salt-shaped spelling on either side is still seen.
 */
function candidateOfEnrich(existing: ProductRecord, input: ProductInput): NegligibleCandidate {
  return {
    name: existing.name,
    aliases: [...existing.aliases, ...(input.aliases ?? []), input.name],
    ingredients: (input.ingredients?.trim() || null) ?? existing.ingredients,
    nutrition_per_100g: mergeNutrition(existing.nutrition_per_100g, normalizeNutrition(input.nutrition_per_100g)),
    nutrition_per_serving: mergeNutrition(
      existing.nutrition_per_serving,
      normalizeNutrition(input.nutrition_per_serving)
    ),
    serving_size_g: input.serving_size_g ?? existing.serving_size_g,
  };
}

/**
 * Apply a `PATCH` panel body onto a stored panel **per field** (§ Product
 * corrections): a supplied number sets that field, a supplied `null` clears just
 * that field, an omitted field is untouched, and `incoming: null` clears the
 * whole panel. Distinct from `mergeNutrition`, which never null-clobbers because
 * its input is a scan that may simply not have read a line.
 */
function patchPanel(
  existing: NutritionPer100g | null,
  incoming: Partial<NutritionPer100g> | null | undefined
): NutritionPer100g | null {
  if (incoming === null) return null;
  if (incoming === undefined) return existing;
  const out = {} as NutritionPer100g;
  let any = false;
  for (const k of NUTRITION_KEYS) {
    const supplied = Object.prototype.hasOwnProperty.call(incoming, k) ? incoming[k] : undefined;
    const value = supplied !== undefined ? supplied : existing?.[k] ?? null;
    out[k] = typeof value === 'number' && Number.isFinite(value) ? value : null;
    if (out[k] !== null) any = true;
  }
  return any ? out : null;
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
  'added_sugar_g',
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
    total_cents: b.total_cents,
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
    price_cents: l.price_cents,
    match_outcome: l.match_outcome,
    product_ulid: l.product_ulid,
    inventory_item_ulid: l.inventory_item_ulid,
    created_at: typeof l.created_at === 'string' ? l.created_at : l.created_at.toISOString(),
  };
}
