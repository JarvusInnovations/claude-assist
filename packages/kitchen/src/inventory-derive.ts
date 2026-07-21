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
  ShelfLifeClass,
} from './inventory-types.js';

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
 * Project a stored item (+ optional joined product name) into the wire view,
 * computing days_until_eat_by / age_days relative to `now`.
 */
export function toItemView(
  record: InventoryItemRecord,
  productName: string | null,
  now = new Date(),
  derivedFrom: DerivedFromView | null = null
): InventoryItemView {
  const today = new Date(now.toISOString().slice(0, 10));
  return {
    ulid: record.ulid,
    product_ulid: record.product_ulid,
    product_name: productName ?? record.raw_label ?? null,
    raw_label: record.raw_label,
    store: record.store,
    batch_ulid: record.batch_ulid,
    state: record.state,
    on_hand_fraction: record.on_hand_fraction,
    units_total: record.units_total,
    units_remaining: record.units_remaining,
    needs_info: record.needs_info,
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
