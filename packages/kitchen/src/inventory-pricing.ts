/**
 * Price history + waste costing — the pure core (specs/modules/kitchen.md
 * § Price history, § Waste costing).
 *
 * Everything here is a derivation over rows that already exist: a batch line's
 * transcribed price, the batch's date/store, the lexicon's package size, the
 * product's label-derived net content, and an item's toss notes. No prices are
 * stored, computed once and cached, or copied onto another table — a corrected
 * line or a re-scanned label immediately corrects every read that quotes it.
 *
 * No store access and no I/O, so the interesting cases (a divisor that differs
 * between two purchases of one product, a partial toss of a multipack, a
 * product with no price at all) are testable directly.
 */

import { convertNetContent } from './services/label-parser.js';
import type {
  PricePoint,
  ProductRecord,
  UnitBasis,
  WasteCostBasis,
} from './inventory-types.js';

// ── Printed measures ─────────────────────────────────────────────────────────

/** A measure as printed, before any unit conversion. */
export interface Measure {
  value: number;
  unit: string;
}

/**
 * Units `parseMeasure` recognizes, longest spelling first so "fl oz" wins over
 * "oz" and "lbs" over "lb". Deliberately the same vocabulary the label scan's
 * net-content conversion accepts (`convertNetContent`) — a size string and a
 * transcribed label figure must never normalize differently.
 */
const MEASURE_UNITS: readonly string[] = [
  'fluid ounces', 'fluid ounce', 'fluid oz', 'fl oz', 'floz',
  'milliliters', 'milliliter', 'millilitres', 'millilitre',
  'gallons', 'gallon', 'gal',
  'quarts', 'quart', 'qt',
  'pints', 'pint', 'pt',
  'liters', 'liter', 'litres', 'litre',
  'pounds', 'pound', 'lbs', 'lb',
  'ounces', 'ounce', 'oz',
  'grams', 'gram', 'kg', 'g',
  'ml', 'l',
];

const MEASURE_PATTERN = new RegExp(
  String.raw`(?<![a-z0-9.])(\d+(?:\.\d+)?)\s*(` + MEASURE_UNITS.join('|') + String.raw`)(?![a-z])`,
  'i'
);

/**
 * Pull a printed measure out of a free-form string — a package size ("16 oz",
 * "1.36 kg", "750ML") or a whole receipt line ("BULK RICE 1.42 LB @ 0.79/LB",
 * "OLV OL X-VRG 750ML"). The FIRST measure wins: a weighed line prints its
 * measure before the per-unit rate, so taking the first avoids reading
 * "0.79/LB" as the quantity purchased.
 *
 * Returns null when the string carries no measure at all — including a
 * count-stated size ("12 ct", "3-pack"), which is the unit model's axis, not a
 * mass. A null here is what makes a point's normalized price honestly null
 * rather than divided by a guessed divisor.
 */
export function parseMeasure(text: string | null | undefined): Measure | null {
  if (!text) return null;
  const match = text.match(MEASURE_PATTERN);
  if (!match) return null;
  const value = parseFloat(match[1]!);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, unit: match[2]!.toLowerCase().replace(/\s+/g, ' ') };
}

/**
 * Convert a printed measure to grams OR millilitres (never both, never
 * cross-converted — no assumed 1 g/ml). Delegates to the label scan's
 * deterministic conversion so there is exactly one weight/volume table in the
 * module.
 */
export function measureToUnits(
  measure: Measure | null
): { grams: number | null; millilitres: number | null } {
  const converted = convertNetContent(measure);
  return { grams: converted.net_content_g, millilitres: converted.net_content_ml };
}

// ── Unit basis (the per-point divisor) ───────────────────────────────────────

/** The size a price point normalizes by, and where it came from. */
export interface ResolvedUnitBasis {
  basis: UnitBasis;
  grams: number | null;
  millilitres: number | null;
}

const NO_BASIS: ResolvedUnitBasis = { basis: null, grams: null, millilitres: null };

/**
 * Resolve the divisor for ONE price point, most-specific source first
 * (§ Price history — "the divisor belongs to the POINT, not the product"):
 *
 * 1. a measure printed in the line's own `raw_text` — it describes *that*
 *    purchase, which is why a weighed line and a 12-oz bag both land here;
 * 2. the lexicon `package_size` for that store's line text;
 * 3. the product's label-derived `net_content_g` / `net_content_ml`;
 * 4. the product's `package_size` string.
 *
 * A source that yields neither grams nor millilitres (a count-stated size) does
 * not consume the precedence — resolution falls through to the next source, so
 * a "12 ct" lexicon size never blocks a real net content behind it.
 */
export function resolveUnitBasis(inputs: {
  rawText?: string | null;
  lexiconPackageSize?: string | null;
  product?: Pick<ProductRecord, 'net_content_g' | 'net_content_ml' | 'package_size'> | null;
}): ResolvedUnitBasis {
  const fromText = measureToUnits(parseMeasure(inputs.rawText));
  if (fromText.grams != null || fromText.millilitres != null) {
    return { basis: 'line', grams: fromText.grams, millilitres: fromText.millilitres };
  }
  const fromLexicon = measureToUnits(parseMeasure(inputs.lexiconPackageSize));
  if (fromLexicon.grams != null || fromLexicon.millilitres != null) {
    return { basis: 'lexicon', grams: fromLexicon.grams, millilitres: fromLexicon.millilitres };
  }
  const product = inputs.product ?? null;
  if (product?.net_content_g != null || product?.net_content_ml != null) {
    return {
      basis: 'product_net_content',
      grams: product.net_content_g ?? null,
      millilitres: product.net_content_ml ?? null,
    };
  }
  const fromProductSize = measureToUnits(parseMeasure(product?.package_size));
  if (fromProductSize.grams != null || fromProductSize.millilitres != null) {
    return {
      basis: 'product_package_size',
      grams: fromProductSize.grams,
      millilitres: fromProductSize.millilitres,
    };
  }
  return NO_BASIS;
}

// ── Price points ─────────────────────────────────────────────────────────────

/** One purchase-line-with-batch-context, as the store hands it over. */
export interface PriceLine {
  line_ulid: string;
  batch_ulid: string;
  product_ulid: string | null;
  raw_text: string;
  quantity: number;
  price_cents: number | null;
  /** The line's representative item (the earliest of its fanned-out units). */
  inventory_item_ulid: string | null;
  purchased_at: Date;
  store: string | null;
}

/**
 * The per-physical-unit price: the printed extended price divided by the
 * line's `quantity` (§ Prices — "per-unit price for a multi-quantity line is a
 * read-time division, never stored"). Null when the printed price was
 * unreadable, never 0.
 */
export function packagePriceCents(line: Pick<PriceLine, 'price_cents' | 'quantity'>): number | null {
  if (line.price_cents == null) return null;
  const quantity = line.quantity > 0 ? line.quantity : 1;
  return round2(line.price_cents / quantity);
}

/**
 * Build one `PricePoint` — the wire shape — from a line, the lexicon size for
 * its `(store, line text)`, and the product. Normalized prices are null
 * whenever either half (price or divisor) is missing; they are never zero, and
 * grams/millilitres never substitute for each other.
 */
export function pricePoint(
  line: PriceLine,
  lexiconPackageSize: string | null,
  product: Pick<ProductRecord, 'net_content_g' | 'net_content_ml' | 'package_size'> | null
): PricePoint {
  const basis = resolveUnitBasis({
    rawText: line.raw_text,
    lexiconPackageSize,
    product,
  });
  const packagePrice = packagePriceCents(line);
  const per100 = (units: number | null): number | null =>
    packagePrice == null || units == null || units <= 0 ? null : round2((packagePrice / units) * 100);

  return {
    line_ulid: line.line_ulid,
    batch_ulid: line.batch_ulid,
    purchased_at: isoDate(line.purchased_at),
    store: line.store,
    raw_text: line.raw_text,
    quantity: line.quantity,
    price_cents: line.price_cents,
    package_price_cents: packagePrice,
    unit_basis: basis.basis,
    unit_grams: basis.grams,
    unit_millilitres: basis.millilitres,
    cents_per_100g: per100(basis.grams),
    cents_per_100ml: per100(basis.millilitres),
  };
}

// ── Toss notes (the only record of a waste QUANTITY) ─────────────────────────

/** One toss, as recovered from an item's notes. */
export interface TossRecord {
  /** Package fraction discarded (0..1); null when the note was unparseable. */
  amount_fraction: number | null;
  /** Sealed units discarded — counted items only, null otherwise. */
  units: number | null;
  /** ISO date the toss was recorded for. */
  tossed_at: string;
}

/**
 * `tossed <fraction> <date>` — the line every toss appends — with the optional
 * `(<n>u)` sealed-unit count a counted item's toss carries (§ Inventory state
 * machine). Anchored to a line start so a note someone typed *about* a toss is
 * not mistaken for the ledger's own record.
 */
const TOSS_NOTE_PATTERN =
  /^tossed\s+(\d+(?:\.\d+)?)(?:\s+\((\d+)u\))?\s+(\d{4}-\d{2}-\d{2})\s*$/;

/**
 * Recover every toss an item's notes record, oldest line first.
 *
 * This is the module's only record of a waste *quantity*: a full toss zeroes
 * `on_hand_fraction` and a partial one decrements it, so neither leaves the
 * amount discarded behind in a column. Waste reads therefore parse these lines
 * — but whether a toss *counts* is a structured-state question, never a note
 * question (§ Waste costing).
 */
export function parseTossNotes(notes: string | null | undefined): TossRecord[] {
  if (!notes) return [];
  const out: TossRecord[] = [];
  for (const raw of notes.split('\n')) {
    const match = raw.trim().match(TOSS_NOTE_PATTERN);
    if (!match) continue;
    const fraction = parseFloat(match[1]!);
    const units = match[2] ? parseInt(match[2], 10) : null;
    out.push({
      amount_fraction: Number.isFinite(fraction) ? fraction : null,
      units: units != null && Number.isFinite(units) ? units : null,
      tossed_at: match[3]!,
    });
  }
  return out;
}

/** Render the waste line a toss appends, with a counted item's unit count. */
export function tossNoteLine(
  amountFraction: number,
  isoTossedAt: string,
  unitsDiscarded: number | null
): string {
  const units = unitsDiscarded != null && unitsDiscarded > 0 ? ` (${unitsDiscarded}u)` : '';
  return `tossed ${amountFraction}${units} ${isoTossedAt}`;
}

// ── Waste cost ───────────────────────────────────────────────────────────────

export interface WasteCost {
  cost_cents: number | null;
  cost_basis: WasteCostBasis;
}

const UNKNOWN_COST: WasteCost = { cost_cents: null, cost_basis: 'unknown' };

/**
 * Cost one toss (§ Waste costing). Scales to the amount ACTUALLY discarded:
 *
 * - **counted item** — the per-sealed-unit price (package ÷ `units_total`)
 *   times the units discarded, so 2 of a 12-pack costs two twelfths;
 * - **fraction-modeled item** — the package price times the fraction tossed.
 *
 * `basis` is the caller's attribution decision (the item's own batch line, or
 * the product's nearest priced purchase) and is passed through so the row can
 * report it. With no priced line, or no recoverable amount, the answer is
 * **unknown** — `cost_cents: null`, never `0`: zero would state that throwing
 * the food away cost nothing, which is the opposite of what this read exists
 * to say.
 */
export function wasteCost(
  toss: Pick<TossRecord, 'amount_fraction' | 'units'>,
  packagePrice: number | null,
  basis: Exclude<WasteCostBasis, 'unknown'>,
  unitsTotal: number | null
): WasteCost {
  if (packagePrice == null) return UNKNOWN_COST;

  if (toss.units != null && unitsTotal != null && unitsTotal > 0) {
    const units = Math.min(toss.units, unitsTotal);
    return { cost_cents: round2((packagePrice / unitsTotal) * units), cost_basis: basis };
  }
  if (toss.amount_fraction != null) {
    const fraction = Math.min(Math.max(toss.amount_fraction, 0), 1);
    return { cost_cents: round2(packagePrice * fraction), cost_basis: basis };
  }
  return UNKNOWN_COST;
}

/**
 * Pick the priced line to cost an item's toss by, when the item's OWN line is
 * unavailable or unpriced (§ Waste costing, fallback 2): the latest priced
 * purchase at or before the item was acquired — the price in force when it
 * entered the house — else the earliest priced purchase after it, for an item
 * that predates every recorded price. `lines` may be in any order.
 */
export function nearestPricedLine<T extends { purchased_at: Date; price_cents: number | null }>(
  lines: readonly T[],
  acquiredAt: Date
): T | null {
  let before: T | null = null;
  let after: T | null = null;
  for (const line of lines) {
    if (line.price_cents == null) continue;
    if (line.purchased_at.getTime() <= acquiredAt.getTime()) {
      if (!before || line.purchased_at.getTime() > before.purchased_at.getTime()) before = line;
    } else if (!after || line.purchased_at.getTime() < after.purchased_at.getTime()) {
      after = line;
    }
  }
  return before ?? after;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Cents to two decimals. Prices divide (by a line quantity, a unit count, a
 * package fraction), so a cent-integer result is not guaranteed; rounding to
 * the hundredth of a cent keeps a 12-pack's per-unit share honest instead of
 * losing it to integer truncation.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
