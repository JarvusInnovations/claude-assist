import { describe, expect, it } from 'bun:test';
import {
  measureToUnits,
  nearestPricedLine,
  packagePriceCents,
  parseMeasure,
  parseTossNotes,
  pricePoint,
  resolveUnitBasis,
  tossNoteLine,
  wasteCost,
  type PriceLine,
} from './inventory-pricing.js';
import type { ProductRecord } from './inventory-types.js';

const ULID = (n: number) => `01J${String(n).padStart(23, '0')}`.toUpperCase();

function product(overrides: Partial<ProductRecord> = {}): ProductRecord {
  return {
    ulid: ULID(1),
    name: 'Store-brand rolled oats',
    shelf_life_class: 'pantry',
    aliases: [],
    nutrition_per_100g: null,
    serving_size_g: null,
    nutrition_per_serving: null,
    servings_per_container: null,
    unit_model_hint: null,
    net_content_g: null,
    net_content_ml: null,
    ingredients: null,
    package_size: null,
    shelf_life_days_unopened: null,
    shelf_life_days_opened: null,
    nutrition_negligible: false,
    archived_at: null,
    merged_into: null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    ...overrides,
  };
}

function line(overrides: Partial<PriceLine> = {}): PriceLine {
  return {
    line_ulid: ULID(10),
    batch_ulid: ULID(20),
    product_ulid: ULID(1),
    raw_text: 'ROLLED OATS',
    quantity: 1,
    price_cents: 399,
    inventory_item_ulid: null,
    purchased_at: new Date('2026-07-01'),
    store: 'Example Grocer',
    ...overrides,
  };
}

describe('parseMeasure', () => {
  it('reads a printed package size, with or without a space', () => {
    expect(parseMeasure('16 oz')).toEqual({ value: 16, unit: 'oz' });
    expect(parseMeasure('750ML')).toEqual({ value: 750, unit: 'ml' });
    expect(parseMeasure('1.36 kg')).toEqual({ value: 1.36, unit: 'kg' });
    expect(parseMeasure('64 FL OZ')).toEqual({ value: 64, unit: 'fl oz' });
  });

  it('takes the FIRST measure on a weighed receipt line, not the per-unit rate', () => {
    // "1.42 lb @ 0.79/lb" — the quantity purchased precedes the rate, so the
    // first match is the one that describes the purchase.
    expect(parseMeasure('BULK RICE 1.42 LB @ 0.79/LB')).toEqual({ value: 1.42, unit: 'lb' });
  });

  it('finds a size embedded in an abbreviated line', () => {
    expect(parseMeasure('OLV OL X-VRG 750ML')).toEqual({ value: 750, unit: 'ml' });
  });

  it('is null for a count-stated size or no measure at all — a count is not a mass', () => {
    expect(parseMeasure('12 ct')).toBeNull();
    expect(parseMeasure('3-pack')).toBeNull();
    expect(parseMeasure('MYSTERY ITEM')).toBeNull();
    expect(parseMeasure(null)).toBeNull();
    expect(parseMeasure('')).toBeNull();
  });

  it('never reads a digit out of the middle of another number or word', () => {
    // "12PK" carries no unit; the "2" must not be read as 2 of anything.
    expect(parseMeasure('SODA 12PK CANS')).toBeNull();
  });
});

describe('measureToUnits', () => {
  it('converts weight to grams and volume to millilitres, never both', () => {
    expect(measureToUnits({ value: 16, unit: 'oz' })).toEqual({ grams: 453.6, millilitres: null });
    expect(measureToUnits({ value: 1, unit: 'l' })).toEqual({ grams: null, millilitres: 1000 });
  });

  it('is null/null for an unconvertible measure', () => {
    expect(measureToUnits(null)).toEqual({ grams: null, millilitres: null });
  });
});

describe('resolveUnitBasis', () => {
  it('prefers a measure on the line itself over every other source', () => {
    const resolved = resolveUnitBasis({
      rawText: 'ROLLED OATS 12 OZ',
      lexiconPackageSize: '16 oz',
      product: product({ net_content_g: 907 }),
    });
    expect(resolved.basis).toBe('line');
    expect(resolved.grams).toBeCloseTo(340.2, 1);
  });

  it('falls back to the lexicon size, then net content, then the product size', () => {
    expect(
      resolveUnitBasis({
        rawText: 'ROLLED OATS',
        lexiconPackageSize: '16 oz',
        product: product({ net_content_g: 907 }),
      }).basis
    ).toBe('lexicon');
    expect(
      resolveUnitBasis({ rawText: 'ROLLED OATS', product: product({ net_content_g: 907 }) })
    ).toEqual({ basis: 'product_net_content', grams: 907, millilitres: null });
    expect(
      resolveUnitBasis({ rawText: 'ROLLED OATS', product: product({ package_size: '18 oz' }) }).basis
    ).toBe('product_package_size');
  });

  it('falls THROUGH a count-stated size rather than letting it block a real one', () => {
    // A "12 ct" lexicon size resolves to no mass, so the label's net content
    // behind it must still win — otherwise a multipack could never normalize.
    const resolved = resolveUnitBasis({
      rawText: 'EGGS',
      lexiconPackageSize: '12 ct',
      product: product({ net_content_g: 600 }),
    });
    expect(resolved).toEqual({ basis: 'product_net_content', grams: 600, millilitres: null });
  });

  it('resolves nothing when no source carries a size — never a guessed divisor', () => {
    expect(resolveUnitBasis({ rawText: 'MYSTERY ITEM', product: product() })).toEqual({
      basis: null,
      grams: null,
      millilitres: null,
    });
  });
});

describe('packagePriceCents', () => {
  it('divides a multi-quantity line by its quantity', () => {
    expect(packagePriceCents({ price_cents: 900, quantity: 3 })).toBe(300);
  });

  it('is null — not zero — when the printed price was unreadable', () => {
    expect(packagePriceCents({ price_cents: null, quantity: 2 })).toBeNull();
  });
});

describe('pricePoint — unit normalization across differing package sizes', () => {
  it('normalizes two purchases of one product whose package sizes differ', () => {
    // The same-looking prices are NOT the same value per gram: this is the whole
    // reason the read normalizes rather than listing prices (§ Price history).
    const twelveOz = pricePoint(
      line({ line_ulid: ULID(11), raw_text: 'ROLLED OATS 12 OZ', price_cents: 349 }),
      null,
      product()
    );
    const sixteenOz = pricePoint(
      line({ line_ulid: ULID(12), raw_text: 'ROLLED OATS 16 OZ', price_cents: 399 }),
      null,
      product()
    );

    expect(twelveOz.unit_basis).toBe('line');
    expect(twelveOz.unit_grams).toBeCloseTo(340.2, 1);
    expect(twelveOz.cents_per_100g).toBeCloseTo(102.59, 1);
    expect(sixteenOz.unit_grams).toBeCloseTo(453.6, 1);
    expect(sixteenOz.cents_per_100g).toBeCloseTo(87.96, 1);
    // Cheaper per package is NOT cheaper per gram.
    expect(twelveOz.price_cents!).toBeLessThan(sixteenOz.price_cents!);
    expect(twelveOz.cents_per_100g!).toBeGreaterThan(sixteenOz.cents_per_100g!);
  });

  it('normalizes a multi-quantity line per PACKAGE, not per line total', () => {
    const point = pricePoint(
      line({ raw_text: 'YOGURT 6 OZ', quantity: 4, price_cents: 400 }),
      null,
      product()
    );
    expect(point.package_price_cents).toBe(100);
    // 100¢ for 170.1 g → ~58.79¢/100 g, not four times that.
    expect(point.cents_per_100g).toBeCloseTo(58.79, 1);
  });

  it('normalizes a by-weight line off the measure printed on it', () => {
    const point = pricePoint(
      line({ raw_text: 'BULK BROWN RICE 1.42 LB @ 0.79/LB', price_cents: 112 }),
      null,
      product()
    );
    expect(point.unit_basis).toBe('line');
    expect(point.unit_grams).toBeCloseTo(644.1, 0);
    expect(point.cents_per_100g).toBeCloseTo(17.39, 1);
  });

  it('never cross-converts weight and volume', () => {
    const point = pricePoint(line({ raw_text: 'OLIVE OIL 750ML', price_cents: 1299 }), null, product());
    expect(point.cents_per_100ml).toBeCloseTo(173.2, 1);
    expect(point.cents_per_100g).toBeNull();
    expect(point.unit_grams).toBeNull();
  });

  it('keeps an unpriced purchase as a point with null prices, never zero', () => {
    const point = pricePoint(line({ price_cents: null, raw_text: 'ROLLED OATS 16 OZ' }), null, product());
    expect(point.price_cents).toBeNull();
    expect(point.package_price_cents).toBeNull();
    expect(point.cents_per_100g).toBeNull();
    // The divisor still resolved — the gap is the price, and the point says so.
    expect(point.unit_basis).toBe('line');
  });

  it('leaves the normalized price null when no size resolves', () => {
    const point = pricePoint(line({ raw_text: 'MYSTERY ITEM' }), null, product());
    expect(point.unit_basis).toBeNull();
    expect(point.cents_per_100g).toBeNull();
    expect(point.cents_per_100ml).toBeNull();
    expect(point.package_price_cents).toBe(399);
  });
});

describe('toss notes', () => {
  it('round-trips the line a toss appends, with and without a unit count', () => {
    expect(tossNoteLine(0.5, '2026-07-20', null)).toBe('tossed 0.5 2026-07-20');
    expect(tossNoteLine(1, '2026-07-20', 3)).toBe('tossed 1 (3u) 2026-07-20');
    expect(parseTossNotes(tossNoteLine(1, '2026-07-20', 3))).toEqual([
      { amount_fraction: 1, units: 3, tossed_at: '2026-07-20' },
    ]);
  });

  it('recovers every toss on an item, oldest first, ignoring other notes lines', () => {
    const notes = [
      'reconciled 2026-07-10: recount',
      'tossed 0.25 2026-07-18',
      'some free text about tossing food out',
      'tossed 0.5 2026-07-21',
    ].join('\n');
    expect(parseTossNotes(notes)).toEqual([
      { amount_fraction: 0.25, units: null, tossed_at: '2026-07-18' },
      { amount_fraction: 0.5, units: null, tossed_at: '2026-07-21' },
    ]);
  });

  it('is empty for no notes at all', () => {
    expect(parseTossNotes(null)).toEqual([]);
    expect(parseTossNotes('opened early')).toEqual([]);
  });
});

describe('wasteCost', () => {
  it('scales a partial toss to the fraction discarded, not the package', () => {
    expect(wasteCost({ amount_fraction: 0.25, units: null }, 400, 'batch_line', null)).toEqual({
      cost_cents: 100,
      cost_basis: 'batch_line',
    });
  });

  it('scales a counted item to the SEALED UNITS discarded', () => {
    // 2 of a 12-pack that cost 600¢ → two twelfths, not the pack.
    expect(wasteCost({ amount_fraction: 1, units: 2 }, 600, 'batch_line', 12)).toEqual({
      cost_cents: 100,
      cost_basis: 'batch_line',
    });
  });

  it('prefers the unit count over the fraction when both are recorded', () => {
    // The fraction reads 1.0 on a counted pack with units left, which would
    // charge the whole pack; the unit count is the honest number.
    const byUnits = wasteCost({ amount_fraction: 1, units: 3 }, 1200, 'batch_line', 12);
    expect(byUnits.cost_cents).toBe(300);
  });

  it('is unknown — null, never 0 — with no price on file', () => {
    expect(wasteCost({ amount_fraction: 1, units: null }, null, 'batch_line', null)).toEqual({
      cost_cents: null,
      cost_basis: 'unknown',
    });
  });

  it('is unknown when the amount discarded could not be recovered', () => {
    expect(wasteCost({ amount_fraction: null, units: null }, 500, 'product_price', null)).toEqual({
      cost_cents: null,
      cost_basis: 'unknown',
    });
  });
});

describe('nearestPricedLine', () => {
  const early = line({ line_ulid: ULID(31), purchased_at: new Date('2026-05-01'), price_cents: 300 });
  const mid = line({ line_ulid: ULID(32), purchased_at: new Date('2026-06-01'), price_cents: 350 });
  const late = line({ line_ulid: ULID(33), purchased_at: new Date('2026-08-01'), price_cents: 425 });
  const unpriced = line({ line_ulid: ULID(34), purchased_at: new Date('2026-07-01'), price_cents: null });

  it('takes the latest priced purchase at or before acquisition', () => {
    expect(nearestPricedLine([early, late, mid, unpriced], new Date('2026-07-15'))?.line_ulid).toBe(ULID(32));
  });

  it('falls forward to the earliest later purchase for an item that predates every price', () => {
    expect(nearestPricedLine([mid, late], new Date('2026-01-01'))?.line_ulid).toBe(ULID(32));
  });

  it('ignores unpriced lines entirely, and is null with nothing priced', () => {
    expect(nearestPricedLine([unpriced], new Date('2026-07-15'))).toBeNull();
    expect(nearestPricedLine([], new Date('2026-07-15'))).toBeNull();
  });
});
