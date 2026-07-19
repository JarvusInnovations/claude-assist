/**
 * Eat-by derivation + inventory view projection.
 *
 * Directional, never gram-accurate: eat_by comes from the shelf-life class's
 * default day windows (or a product-level override), applied to the opened
 * date once opened, else the acquired date. `unknown` (or any null window)
 * yields no eat_by — the item simply carries no urgency until a label lands.
 */

import type {
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
 * with the unopened window. Null window (unknown class, or missing override
 * with an unknown class) → null eat_by.
 */
export function deriveEatBy(inputs: EatByInputs): Date | null {
  const cls = inputs.shelfLifeClass ?? 'unknown';
  const window = SHELF_LIFE_WINDOWS[cls] ?? SHELF_LIFE_WINDOWS.unknown;

  if (inputs.openedAt) {
    const days = inputs.daysOpenedOverride ?? window.opened;
    if (days === null || days === undefined) return null;
    return addDays(inputs.openedAt, days);
  }
  const days = inputs.daysUnopenedOverride ?? window.unopened;
  if (days === null || days === undefined) return null;
  return addDays(inputs.acquiredAt, days);
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
  now = new Date()
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
    needs_info: record.needs_info,
    acquired_at: toIsoDate(record.acquired_at)!,
    opened_at: toIsoDate(record.opened_at),
    closed_at: toIsoDate(record.closed_at),
    eat_by: toIsoDate(record.eat_by),
    shelf_life_class: record.shelf_life_class,
    days_until_eat_by: dayDiff(today, record.eat_by),
    age_days: dayDiff(record.acquired_at, today),
    notes: record.notes,
    created_at: record.created_at.toISOString(),
    updated_at: record.updated_at.toISOString(),
  };
}
