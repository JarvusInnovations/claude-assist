import { describe, expect, it } from 'bun:test';
import { InvalidTransitionError, isTerminal, transitionInventory } from './inventory-state.js';
import { deriveEatBy, dayDiff, toIsoDate, SHELF_LIFE_WINDOWS, parsePackageCount } from './inventory-derive.js';
import { matchScore, parseRemark } from './inventory-remark.js';

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

  it('dayDiff floors whole days and null-propagates', () => {
    expect(dayDiff(new Date('2026-07-01'), new Date('2026-07-05'))).toBe(4);
    expect(dayDiff(null, new Date())).toBeNull();
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

  it('scores matches conservatively', () => {
    expect(matchScore('feta', 'feta')).toBe(3);
    expect(matchScore('feta', 'Feta Cheese')).toBe(2);
    expect(matchScore('cherry tomatoes', 'grape tomatoes')).toBe(1);
    expect(matchScore('feta', 'oat milk')).toBe(0);
  });
});
