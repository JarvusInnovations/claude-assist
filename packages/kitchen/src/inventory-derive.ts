/**
 * Eat-by derivation + inventory view projection.
 *
 * Directional, never gram-accurate: eat_by comes from the shelf-life class's
 * default day windows (or a product-level override), applied to the opened
 * date once opened, else the acquired date. `unknown` (or any null window)
 * yields no eat_by — the item simply carries no urgency until a label lands.
 */

import type {
  DerivedFromView,
  InventoryItemRecord,
  InventoryItemView,
  NutritionPer100g,
  ProductRecord,
  ShelfLifeClass,
} from './inventory-types.js';
import { NUTRITION_FIELD_KEYS, normalizeRecipeName } from './types.js';

/** Default (unopened, opened) day windows per shelf-life class; null = no eat-by. */
export const SHELF_LIFE_WINDOWS: Record<ShelfLifeClass, { unopened: number | null; opened: number | null }> = {
  pantry: { unopened: 365, opened: 180 },
  frozen: { unopened: 180, opened: 90 },
  fridge_long: { unopened: 60, opened: 21 },
  fridge_short: { unopened: 14, opened: 7 },
  produce: { unopened: 7, opened: 4 },
  very_perishable: { unopened: 3, opened: 2 },
  // A cooked/assembled dish: ~4 days from the make date. Equal windows because
  // it ages from acquired_at regardless of open state (see deriveEatBy) — a
  // homemade jar doesn't get a fresh clock when you start eating it.
  prepared: { unopened: 4, opened: 4 },
  unknown: { unopened: null, opened: null },
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Add whole days to a date, returning a new Date (UTC-safe date arithmetic). */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Whole-day difference b - a (floored), or null if either is null. */
export function dayDiff(a: Date | null, b: Date | null): number | null {
  if (!a || !b) return null;
  return Math.floor((b.getTime() - a.getTime()) / MS_PER_DAY);
}

export interface EatByInputs {
  shelfLifeClass: ShelfLifeClass | null;
  acquiredAt: Date;
  openedAt: Date | null;
  /** Product-level precise overrides (label-derived); win over the class default. */
  daysUnopenedOverride?: number | null;
  daysOpenedOverride?: number | null;
}

/**
 * Derive eat_by from shelf-life class + acquired/opened dates. Opened items
 * measure from opened_at with the opened window; unopened from acquired_at
 * with the unopened window. A `prepared` dish is the exception — it always
 * measures from acquired_at (the make date), because opening a homemade dish
 * doesn't grant it a fresh window. Null window (unknown class, or missing
 * override with an unknown class) → null eat_by.
 */
export function deriveEatBy(inputs: EatByInputs): Date | null {
  const cls = inputs.shelfLifeClass ?? 'unknown';
  const window = SHELF_LIFE_WINDOWS[cls] ?? SHELF_LIFE_WINDOWS.unknown;

  // Prepared dishes age from the make date; every other class resets to the
  // opened window once the seal is broken.
  if (inputs.openedAt && cls !== 'prepared') {
    const days = inputs.daysOpenedOverride ?? window.opened;
    if (days === null || days === undefined) return null;
    return addDays(inputs.openedAt, days);
  }
  const days = inputs.daysUnopenedOverride ?? window.unopened;
  if (days === null || days === undefined) return null;
  return addDays(inputs.acquiredAt, days);
}

/**
 * Normalize a receipt line / raw label for exact-string lexicon matching
 * (upper + collapse whitespace). Canonical home for this normalization — both
 * the receipt parser's lexicon lookups (services/inventory.ts) and the
 * lexicon-upsert retro-resolve (inventory-store.ts, inventory-memory-store.ts)
 * key off this same function so a line always normalizes identically
 * everywhere it's compared.
 */
export function normalizeLexiconLine(text: string): string {
  return text.trim().toUpperCase().replace(/\s+/g, ' ');
}

const HALF_DOZEN_PATTERN = /\bhalf[- ]dozen\b/i;
const DOZEN_PATTERN = /\bdozen\b/i;
const PACKAGE_COUNT_PATTERN = /(\d+)\s*-?\s*(?:ct|count|pk|pack|pcs?|pieces?)\b/i;

/**
 * Extract a sealed-unit count from a free-form package-size string ("3 ct",
 * "12-pack", "6 pk", "dozen"), or null when the string carries no discernible
 * count. Used by receipt intake to seed `units_total` on a multipack (§
 * count-vs-fraction principle) — a plain size like "16 oz" or "1 lb" has no
 * count and stays fraction-modeled. Requires a count of 2+: "1 ct" describes a
 * single unit, not a multipack.
 */
export function parsePackageCount(size: string | null | undefined): number | null {
  if (!size) return null;
  const text = size.trim();
  if (!text) return null;
  if (HALF_DOZEN_PATTERN.test(text)) return 6;
  if (DOZEN_PATTERN.test(text)) return 12;
  const match = text.match(PACKAGE_COUNT_PATTERN);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  return Number.isFinite(n) && n >= 2 ? n : null;
}

/** ISO date (YYYY-MM-DD) for a Date, or null. */
export function toIsoDate(date: Date | null): string | null {
  if (!date) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * The nine § Nutrition panel keys a product's per-100g reference must carry to
 * be complete — the canonical list (types.ts), never a second copy.
 */
const PANEL_KEYS: readonly (keyof NutritionPer100g)[] = NUTRITION_FIELD_KEYS;

/**
 * Whether an item's linked product is missing nutrition data (§ Nutrition
 * panel — the "needs nutrition" signal): no `nutrition_per_100g` at all, or a
 * panel with any of the nine fields null/absent. A label rescan is the
 * resolving action. Items with NO linked product are the `needs_info` case
 * instead — this flag stays false there to avoid double-badging.
 *
 * A `nutrition_negligible` product is **exempt** (§ Nutritionally negligible
 * products): the flag means "a number is missing that could be found", and for
 * a spice jar — which carries no Nutrition Facts panel at all, because FDA
 * exempts foods with insignificant amounts of every nutrient — that is simply
 * untrue. An unclearable flag trains the reader to ignore the clearable ones.
 */
export function needsNutrition(
  product: Pick<ProductRecord, 'nutrition_per_100g' | 'nutrition_negligible'> | null | undefined
): boolean {
  if (!product) return false;
  if (product.nutrition_negligible) return false;
  const n = product.nutrition_per_100g;
  if (!n) return true;
  return PANEL_KEYS.some((key) => typeof n[key] !== 'number');
}

/** A full panel of asserted zeros — what a negligible product resolves to. */
function zeroPanel(): NutritionPer100g {
  return Object.fromEntries(PANEL_KEYS.map((key) => [key, 0])) as unknown as NutritionPer100g;
}

/**
 * A product's **effective** per-100g panel — the single place the negligible
 * marker's zero assertion lives (§ Nutritionally negligible products).
 *
 * A marked product resolves to `0` for every field it doesn't otherwise state,
 * never `null`. That is load-bearing rather than cosmetic: under the module's
 * per-field null semantics one unknown contribution makes a whole day's field
 * read *unknown* (§ Nutrition panel), so a pinch of paprika with a null sodium
 * costs the day its entire sodium figure. Asserting zero is the same move
 * § Filling `added_sugar_g` already requires of whole foods, which state `0`
 * **by definition, not `null`**.
 *
 * The zeros are derived here, never written into storage: the assertion stays
 * one reversible boolean, and a real panel found later supersedes the marker
 * without anyone having to tell asserted zeros from scanned ones.
 */
export function productPanel(
  product: Pick<ProductRecord, 'nutrition_per_100g' | 'nutrition_negligible'> | null | undefined
): NutritionPer100g | null {
  if (!product) return null;
  if (!product.nutrition_negligible) return product.nutrition_per_100g;
  return { ...zeroPanel(), ...(product.nutrition_per_100g ?? {}) };
}

/**
 * Product identity for the name-key upsert and the rename-collision guard
 * (§ Product corrections): case-folded, whitespace-collapsed, trimmed. The same
 * normalization § Recipe corrections keys recipes on — two names differing only
 * in case or spacing are one product, and letting both exist recreates the
 * indistinguishable-duplicate problem the upsert exists to remove.
 */
export function normalizeProductName(name: string): string {
  return normalizeRecipeName(name);
}

/**
 * Project a stored item (+ optional joined product) into the wire view,
 * computing days_until_eat_by / age_days relative to `now`.
 */
export function toItemView(
  record: InventoryItemRecord,
  product: Pick<ProductRecord, 'name' | 'nutrition_per_100g' | 'nutrition_negligible'> | null,
  now = new Date(),
  derivedFrom: DerivedFromView | null = null
): InventoryItemView {
  const today = new Date(now.toISOString().slice(0, 10));
  return {
    ulid: record.ulid,
    product_ulid: record.product_ulid,
    product_name: product?.name ?? record.raw_label ?? null,
    raw_label: record.raw_label,
    store: record.store,
    batch_ulid: record.batch_ulid,
    state: record.state,
    on_hand_fraction: record.on_hand_fraction,
    units_total: record.units_total,
    units_remaining: record.units_remaining,
    needs_info: record.needs_info,
    needs_nutrition: record.product_ulid ? needsNutrition(product) : false,
    acquired_at: toIsoDate(record.acquired_at)!,
    opened_at: toIsoDate(record.opened_at),
    closed_at: toIsoDate(record.closed_at),
    eat_by: toIsoDate(record.eat_by),
    shelf_life_class: record.shelf_life_class,
    days_until_eat_by: dayDiff(today, record.eat_by),
    age_days: dayDiff(record.acquired_at, today),
    notes: record.notes,
    derived_from: derivedFrom,
    created_at: record.created_at.toISOString(),
    updated_at: record.updated_at.toISOString(),
  };
}
