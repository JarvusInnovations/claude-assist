import { describe, expect, it } from 'bun:test';
import { InvalidTransitionError, isTerminal, transitionInventory } from './inventory-state.js';
import {
  deriveEatBy,
  dayDiff,
  isCounted,
  needsNutrition,
  normalizeProductName,
  onHandFractionOf,
  productPanel,
  toIsoDate,
  unitSealOf,
  SHELF_LIFE_WINDOWS,
  parsePackageCount,
} from './inventory-derive.js';
import { matchScore, parseRemark } from './inventory-remark.js';
import type { UnitSeal } from './inventory-types.js';

describe('inventory state machine', () => {
  it('stocked → open → finished/tossed, terminals reject further events', () => {
    expect(transitionInventory('stocked', 'opened')).toBe('open');
    expect(transitionInventory('stocked', 'finished')).toBe('finished');
    expect(transitionInventory('stocked', 'tossed')).toBe('tossed');
    expect(transitionInventory('open', 'finished')).toBe('finished');
    expect(transitionInventory('open', 'tossed')).toBe('tossed');
    // idempotent re-open
    expect(transitionInventory('open', 'opened')).toBe('open');
    expect(isTerminal('finished')).toBe(true);
    expect(isTerminal('tossed')).toBe(true);
    expect(() => transitionInventory('finished', 'opened')).toThrow(InvalidTransitionError);
    expect(() => transitionInventory('tossed', 'finished')).toThrow(InvalidTransitionError);
  });

  it('finished-unit is legal from stocked/open (same preconditions as finished) and terminal-rejects', () => {
    expect(transitionInventory('stocked', 'finished-unit')).toBe('finished');
    expect(transitionInventory('open', 'finished-unit')).toBe('finished');
    expect(() => transitionInventory('finished', 'finished-unit')).toThrow(InvalidTransitionError);
    expect(() => transitionInventory('tossed', 'finished-unit')).toThrow(InvalidTransitionError);
    expect(() => transitionInventory('dismissed', 'finished-unit')).toThrow(InvalidTransitionError);
  });

  it('moved is state-PRESERVING from either live state, and terminal-rejects (§ Storage moves)', () => {
    // A storage move changes the clock, never the open state: moving a sealed
    // pack doesn't open it, moving an open one doesn't re-seal it.
    expect(transitionInventory('stocked', 'moved')).toBe('stocked');
    expect(transitionInventory('open', 'moved')).toBe('open');
    expect(() => transitionInventory('finished', 'moved')).toThrow(InvalidTransitionError);
    expect(() => transitionInventory('tossed', 'moved')).toThrow(InvalidTransitionError);
    expect(() => transitionInventory('dismissed', 'moved')).toThrow(InvalidTransitionError);
  });
});

describe('unit seal + derived fraction (§ count-vs-fraction)', () => {
  const counted = (units_total: number, units_remaining: number, unit_seal: UnitSeal | null = null) =>
    ({ units_total, units_remaining, unit_seal, on_hand_fraction: 1 }) as const;

  it('defaults a counted item to `individual` and leaves a fraction item with no seal', () => {
    expect(unitSealOf(counted(4, 4))).toBe('individual');
    expect(unitSealOf(counted(4, 4, 'shared'))).toBe('shared');
    expect(unitSealOf(counted(4, 4, 'individual'))).toBe('individual');
    // The notion doesn't apply to a divisible container.
    expect(unitSealOf({ units_total: null, units_remaining: null, unit_seal: null })).toBeNull();
    // …and a stray stored value can't resurrect it.
    expect(unitSealOf({ units_total: null, units_remaining: null, unit_seal: 'shared' })).toBeNull();
    expect(isCounted(counted(4, 1))).toBe(true);
    expect(isCounted({ units_total: null, units_remaining: null })).toBe(false);
  });

  it('derives a counted item’s on-hand fraction from the count, not the stored column', () => {
    // The defect this replaces: the stored column stays at 1 while units are
    // consumed, so a pack with 1 of 4 left reported itself as full.
    expect(onHandFractionOf(counted(4, 1))).toBeCloseTo(0.25, 10);
    expect(onHandFractionOf(counted(4, 4))).toBe(1);
    // Zero units agrees with what a terminal close writes to the column.
    expect(onHandFractionOf(counted(4, 0))).toBe(0);
    // A fraction-modeled item still reads its own stored value.
    expect(
      onHandFractionOf({ units_total: null, units_remaining: null, on_hand_fraction: 0.6 })
    ).toBe(0.6);
  });
});

describe('package count parsing (§ count-vs-fraction seeding)', () => {
  it('extracts a discernible multipack count', () => {
    expect(parsePackageCount('3 ct')).toBe(3);
    expect(parsePackageCount('12-ct')).toBe(12);
    expect(parsePackageCount('4-pack')).toBe(4);
    expect(parsePackageCount('6 pk')).toBe(6);
    expect(parsePackageCount('8 pcs')).toBe(8);
    expect(parsePackageCount('dozen')).toBe(12);
    expect(parsePackageCount('half dozen')).toBe(6);
  });

  it('returns null for a plain size (no count) or a single-unit count', () => {
    expect(parsePackageCount('16 oz')).toBeNull();
    expect(parsePackageCount('1 lb')).toBeNull();
    expect(parsePackageCount('1 ct')).toBeNull(); // a single unit, not a multipack
    expect(parsePackageCount(null)).toBeNull();
    expect(parsePackageCount(undefined)).toBeNull();
    expect(parsePackageCount('')).toBeNull();
  });
});

describe('eat-by derivation', () => {
  const acquired = new Date('2026-07-01');

  it('uses the unopened window from acquired date', () => {
    const eatBy = deriveEatBy({ shelfLifeClass: 'fridge_short', acquiredAt: acquired, openedAt: null });
    // fridge_short unopened = 14 days
    expect(toIsoDate(eatBy)).toBe('2026-07-15');
  });

  it('switches to the opened window from the opened date', () => {
    const opened = new Date('2026-07-10');
    const eatBy = deriveEatBy({ shelfLifeClass: 'fridge_short', acquiredAt: acquired, openedAt: opened });
    // fridge_short opened = 7 days from opened
    expect(toIsoDate(eatBy)).toBe('2026-07-17');
  });

  it('honours per-product day overrides over the class default', () => {
    const eatBy = deriveEatBy({
      shelfLifeClass: 'pantry',
      acquiredAt: acquired,
      openedAt: null,
      daysUnopenedOverride: 3,
    });
    expect(toIsoDate(eatBy)).toBe('2026-07-04');
  });

  it('unknown class (or null window) yields no eat-by', () => {
    expect(deriveEatBy({ shelfLifeClass: 'unknown', acquiredAt: acquired, openedAt: null })).toBeNull();
    expect(deriveEatBy({ shelfLifeClass: null, acquiredAt: acquired, openedAt: null })).toBeNull();
    expect(SHELF_LIFE_WINDOWS.unknown.unopened).toBeNull();
  });

  it('prepared class is ~4 days from the make date and ignores opened_at', () => {
    // Window (4, 4); a prepared dish ages from acquired_at, not opened_at.
    expect(SHELF_LIFE_WINDOWS.prepared).toEqual({ unopened: 4, opened: 4 });
    const unopened = deriveEatBy({ shelfLifeClass: 'prepared', acquiredAt: acquired, openedAt: null });
    expect(toIsoDate(unopened)).toBe('2026-07-05');
    // Opened two days after it was made → STILL make_date + 4 (not opened + 4),
    // because opening a homemade dish doesn't grant a fresh window.
    const openedLater = deriveEatBy({
      shelfLifeClass: 'prepared',
      acquiredAt: acquired,
      openedAt: new Date('2026-07-03'),
    });
    expect(toIsoDate(openedLater)).toBe('2026-07-05');
  });

  it('dayDiff floors whole days and null-propagates', () => {
    expect(dayDiff(new Date('2026-07-01'), new Date('2026-07-05'))).toBe(4);
    expect(dayDiff(null, new Date())).toBeNull();
  });

  describe('a storage move re-anchors the clock (§ Storage moves)', () => {
    it('restarts an unopened window from the move date, not from acquisition', () => {
      // Acquired frozen on the 1st, thawed into the fridge on the 8th. The
      // fridge window must run from the 8th (8 + 14 = the 22nd); resuming from
      // acquisition would say the 15th, which is the whole defect.
      const eatBy = deriveEatBy({
        shelfLifeClass: 'fridge_short',
        acquiredAt: acquired,
        openedAt: null,
        storageMovedAt: new Date('2026-07-08'),
      });
      expect(toIsoDate(eatBy)).toBe('2026-07-22');
    });

    it('keeps the OPENED window when an already-open item moves, anchored at the move', () => {
      // Opened on the 3rd, moved to the freezer on the 10th → frozen's OPENED
      // window (90 d) from the 10th. The window CHOICE follows open state; only
      // its anchor moves.
      const eatBy = deriveEatBy({
        shelfLifeClass: 'frozen',
        acquiredAt: acquired,
        openedAt: new Date('2026-07-03'),
        storageMovedAt: new Date('2026-07-10'),
      });
      expect(toIsoDate(eatBy)).toBe('2026-10-08');
    });

    it('takes the LATEST anchor, so move-then-open and open-then-move both come out right', () => {
      // Moved on the 5th, then opened on the 12th → the open wins (7 d → 19th).
      const openedAfter = deriveEatBy({
        shelfLifeClass: 'fridge_short',
        acquiredAt: acquired,
        openedAt: new Date('2026-07-12'),
        storageMovedAt: new Date('2026-07-05'),
      });
      expect(toIsoDate(openedAfter)).toBe('2026-07-19');
      // Opened on the 5th, then moved on the 12th → the move wins (7 d → 19th).
      const movedAfter = deriveEatBy({
        shelfLifeClass: 'fridge_short',
        acquiredAt: acquired,
        openedAt: new Date('2026-07-05'),
        storageMovedAt: new Date('2026-07-12'),
      });
      expect(toIsoDate(movedAfter)).toBe('2026-07-19');
    });

    it('re-anchors a prepared dish too — a move is a physical act, unlike opening', () => {
      // A batch made on the 1st and thawed back on the 20th: unlike opening
      // (which a prepared dish ignores), the move really does start a new clock.
      const eatBy = deriveEatBy({
        shelfLifeClass: 'prepared',
        acquiredAt: acquired,
        openedAt: null,
        storageMovedAt: new Date('2026-07-20'),
      });
      expect(toIsoDate(eatBy)).toBe('2026-07-24');
    });

    it('still yields no eat-by when the destination class has no window', () => {
      expect(
        deriveEatBy({
          shelfLifeClass: 'unknown',
          acquiredAt: acquired,
          openedAt: null,
          storageMovedAt: new Date('2026-07-08'),
        })
      ).toBeNull();
    });
  });
});

describe('remark parsing', () => {
  it('classifies opened / finished / tossed verbs', () => {
    expect(parseRemark('opened the feta')?.type).toBe('opened');
    expect(parseRemark('killed the soymilk')?.type).toBe('finished');
    expect(parseRemark('finished the milk')?.type).toBe('finished');
    expect(parseRemark('tossed the tomatoes')?.type).toBe('tossed');
    expect(parseRemark('threw out the lettuce')?.type).toBe('tossed');
  });

  it('extracts a fraction and the search term', () => {
    const parsed = parseRemark('tossed half the tomatoes');
    expect(parsed?.type).toBe('tossed');
    expect(parsed?.fraction).toBe(0.5);
    expect(parsed?.term).toBe('tomatoes');
  });

  it('strips articles/verbs to leave the item term', () => {
    expect(parseRemark('opened the feta')?.term).toBe('feta');
    expect(parseRemark('used up the almond milk')?.term).toContain('almond');
  });

  it('returns null when no event verb is present', () => {
    expect(parseRemark('bought some feta today')).toBeNull();
    expect(parseRemark('')).toBeNull();
  });

  it('parses a pure quantity observation with a correction cue as a recount (§ Reconcile)', () => {
    const simple = parseRemark('the feta is actually 60% full');
    expect(simple?.type).toBe('recount');
    expect(simple?.fraction).toBe(0.6);
    expect(simple?.term).toBe('feta');

    // Level words work without a percent.
    const full = parseRemark('eggs carton is actually completely full, untouched');
    expect(full?.type).toBe('recount');
    expect(full?.fraction).toBe(1);
  });

  it('recount needs BOTH a cue and an unambiguous quantity; verbs still win', () => {
    // Quantity but no correction cue → unmatched (could be anything).
    expect(parseRemark('the yogurt is 50% full')).toBeNull();
    // Cue but no quantity → unmatched.
    expect(parseRemark('the ledger is wrong about the yogurt')).toBeNull();
    // TWO percents (the wrong ledger value + the observed one) → ambiguous →
    // unmatched; the real 2026-07-21 soymilk remark had exactly this shape.
    expect(parseRemark("soymilk carton is much fuller than the ledger's 34%, roughly 75% remaining")).toBeNull();
    // An event verb wins even alongside correction language.
    expect(parseRemark('actually tossed half the tomatoes')?.type).toBe('tossed');
  });

  it('scores matches conservatively', () => {
    expect(matchScore('feta', 'feta')).toBe(3);
    expect(matchScore('feta', 'Feta Cheese')).toBe(2);
    expect(matchScore('cherry tomatoes', 'grape tomatoes')).toBe(1);
    expect(matchScore('feta', 'oat milk')).toBe(0);
  });
});

describe('needs-nutrition signal (§ Nutrition panel)', () => {
  const full = {
    calories: 100, protein_g: 5, fat_g: 3, sat_fat_g: 1,
    carbs_g: 12, sugar_g: 4, added_sugar_g: 2, fiber_g: 2, sodium_mg: 80,
  };
  /** A panel-bearing product fixture; `nutrition_negligible` off unless stated. */
  const p = (panel: Record<string, number | null> | null, negligible = false) => ({
    nutrition_per_100g: panel as never,
    nutrition_negligible: negligible,
  });

  it('flags a product with no panel or a partial panel; a full panel clears it', () => {
    expect(needsNutrition(null)).toBe(false); // no product = the needs_info case, not this one
    expect(needsNutrition(p(null))).toBe(true);
    expect(needsNutrition(p({ ...full, sodium_mg: null }))).toBe(true);
    expect(needsNutrition(p({ ...full }))).toBe(false);
  });

  it('counts added_sugar_g among the fields a complete panel must carry', () => {
    // A panel seeded before added sugar was tracked is INCOMPLETE, and the
    // resolving action is the same as ever: rescan the label, which prints
    // "Includes Xg Added Sugars". A 0 there is complete; a null is not.
    expect(needsNutrition(p({ ...full, added_sugar_g: null }))).toBe(true);
    expect(needsNutrition(p({ ...full, added_sugar_g: 0 }))).toBe(false);
  });

  it('exempts a nutrition_negligible product however empty its panel is', () => {
    // A spice jar carries NO Nutrition Facts panel (FDA exempts foods with
    // insignificant amounts of every nutrient), so a rescan can never clear the
    // flag — § Nutritionally negligible products.
    expect(needsNutrition(p(null, true))).toBe(false);
    expect(needsNutrition(p({ ...full, sodium_mg: null }, true))).toBe(false);
  });
});

describe('negligible products contribute zeros, not nulls (§ Nutritionally negligible products)', () => {
  const partial = { calories: 282, protein_g: null, fat_g: null, sat_fat_g: null,
    carbs_g: null, sugar_g: null, added_sugar_g: null, fiber_g: null, sodium_mg: null };

  it('resolves an unmarked product to its stored panel, verbatim', () => {
    expect(productPanel(null)).toBeNull();
    expect(productPanel({ nutrition_per_100g: null, nutrition_negligible: false })).toBeNull();
    expect(productPanel({ nutrition_per_100g: partial as never, nutrition_negligible: false })).toEqual(partial);
  });

  it('resolves a marked product with no panel to an all-zero panel', () => {
    // Load-bearing, not cosmetic: one null contribution makes a whole day's
    // field read unknown, so a pinch of paprika with a null sodium would cost
    // the day its entire sodium figure. Zero is the assertion the marker makes.
    const panel = productPanel({ nutrition_per_100g: null, nutrition_negligible: true })!;
    expect(panel.calories).toBe(0);
    expect(panel.sodium_mg).toBe(0);
    expect(Object.values(panel).every((v) => v === 0)).toBe(true);
  });

  it('lets a real stored value win over the asserted zero, field by field', () => {
    // A marker plus a partial panel is legal: the numbers someone actually read
    // stand, and the marker fills the rest. Nothing is written to storage — the
    // zeros are derived here, so unmarking restores the honest nulls.
    const panel = productPanel({ nutrition_per_100g: partial as never, nutrition_negligible: true })!;
    expect(panel.calories).toBe(282);
    expect(panel.sodium_mg).toBe(0);
  });
});

describe('product name key (§ Product corrections)', () => {
  it('case-folds, collapses whitespace, and trims — the same rule recipes use', () => {
    expect(normalizeProductName('  Smoked   PAPRIKA ')).toBe('smoked paprika');
    expect(normalizeProductName('Olive Oil')).toBe(normalizeProductName('olive  oil'));
    expect(normalizeProductName('Olive Oil')).not.toBe(normalizeProductName('Olive Oil Spray'));
  });
});
