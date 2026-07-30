/**
 * The nutrition panel value type (specs/modules/kitchen.md § Panel operations
 * belong in one implementation). Every product named here is a generic food
 * category, never a brand.
 */

import { describe, expect, it } from 'bun:test';
import {
  CALORIE_BAND_FLOOR,
  CALORIE_BAND_PCT,
  NutritionPanelBasisError,
  derivePer100gFromServing,
  per100gPanel,
  perServingPanel,
  scaleToGrams,
  sumFields,
  toPer100g,
  validatePanelFields,
} from './nutrition-panel.js';

describe('constructing a panel — the basis cannot be lost track of', () => {
  it('per100gPanel never needs a serving size', () => {
    const p = per100gPanel({ calories: 100 });
    expect(p.basis).toBe('per_100g');
    expect(p.servingSizeG).toBeNull();
  });

  it('perServingPanel throws without a positive serving size — a runtime error, not a wrong number', () => {
    expect(() => perServingPanel({ calories: 60 }, null)).toThrow(NutritionPanelBasisError);
    expect(() => perServingPanel({ calories: 60 }, 0)).toThrow(NutritionPanelBasisError);
    expect(() => perServingPanel({ calories: 60 }, -5)).toThrow(NutritionPanelBasisError);
    expect(() => perServingPanel({ calories: 60 }, undefined)).toThrow(NutritionPanelBasisError);
  });

  it('perServingPanel succeeds with a positive serving size', () => {
    const p = perServingPanel({ calories: 60 }, 50);
    expect(p.basis).toBe('per_serving');
    expect(p.servingSizeG).toBe(50);
  });
});

describe('toPer100g — the only way to read a different basis', () => {
  it('a per_100g panel is returned unchanged', () => {
    const p = per100gPanel({ calories: 120, sodium_mg: 90 });
    expect(toPer100g(p)).toEqual({ calories: 120, sodium_mg: 90 });
  });

  it('a per_serving panel scales by 100 / servingSizeG', () => {
    const p = perServingPanel({ calories: 60, protein_g: 2, sodium_mg: 45 }, 50);
    expect(toPer100g(p)).toMatchObject({ calories: 120, protein_g: 4, sodium_mg: 90 });
  });

  it('rebase round-trips within float tolerance: per_serving -> per_100g -> back to the same per-serving reading', () => {
    const servingSizeG = 37; // deliberately not a clean divisor of 100
    const original = { calories: 83, protein_g: 3.1, fat_g: 1.4, sodium_mg: 210 };
    const per100 = toPer100g(perServingPanel(original, servingSizeG));
    // Scale back down to the original serving size.
    const backToServing = scaleToGrams(per100Panel(per100), servingSizeG);
    for (const key of Object.keys(original) as (keyof typeof original)[]) {
      expect(Math.abs(backToServing[key]! - original[key])).toBeLessThan(0.15);
    }
  });

  function per100Panel(fields: Record<string, number | null>) {
    return per100gPanel(fields);
  }

  it('a null or missing field stays null after rebasing — never coerced to 0', () => {
    const p = perServingPanel({ calories: 60, sodium_mg: null }, 50);
    const result = toPer100g(p);
    expect(result.sodium_mg).toBeNull();
  });
});

describe('scaleToGrams', () => {
  it('scales a per_100g panel to an arbitrary gram quantity', () => {
    const p = per100gPanel({ calories: 120, protein_g: 4 });
    expect(scaleToGrams(p, 250)).toMatchObject({ calories: 300, protein_g: 10 });
  });

  it('scales a per_serving panel correctly regardless of the target gram quantity', () => {
    const p = perServingPanel({ calories: 60 }, 50); // -> 120 per 100g
    expect(scaleToGrams(p, 200)).toMatchObject({ calories: 240 });
  });
});

describe('sumFields — a field is null only when NO contribution carried it', () => {
  it('sums contributions per field', () => {
    const total = sumFields([{ calories: 100, sodium_mg: 50 }, { calories: 50, sodium_mg: 30 }]);
    expect(total).toMatchObject({ calories: 150, sodium_mg: 80 });
  });

  it('a field missing from every contribution is null, never 0', () => {
    const total = sumFields([{ calories: 100 }, { calories: 50 }]);
    expect(total.fiber_g).toBeNull();
  });

  it('a field present in only SOME contributions still sums (not coerced to unknown)', () => {
    const total = sumFields([{ calories: 100, fiber_g: 2 }, { calories: 50 }]);
    expect(total.calories).toBe(150);
    expect(total.fiber_g).toBe(2);
  });
});

describe('derivePer100gFromServing — the one implementation the label pipeline and the write-door guard share', () => {
  it('returns null with no serving size', () => {
    expect(derivePer100gFromServing(null, { calories: 60 })).toBeNull();
    expect(derivePer100gFromServing(0, { calories: 60 })).toBeNull();
  });

  it('returns null with no per-serving panel', () => {
    expect(derivePer100gFromServing(50, null)).toBeNull();
  });

  it('derives per field when both are present', () => {
    expect(derivePer100gFromServing(50, { calories: 60, protein_g: 2 })).toMatchObject({ calories: 120, protein_g: 4 });
  });
});

describe('validatePanelFields — reject at write time (§ Panel operations belong in one implementation)', () => {
  it('rejects a negative field — no nutrient is ever negative', () => {
    const issues = validatePanelFields({ sodium_mg: -5 });
    expect(issues.some((i) => i.field === 'sodium_mg')).toBe(true);
  });

  it('rejects saturated fat exceeding total fat', () => {
    const issues = validatePanelFields({ fat_g: 2, sat_fat_g: 5 });
    expect(issues.some((i) => i.field === 'sat_fat_g')).toBe(true);
  });

  it('permits saturated fat equal to total fat (a subset, not a strict subset)', () => {
    expect(validatePanelFields({ fat_g: 5, sat_fat_g: 5 })).toEqual([]);
  });

  it('rejects added sugar exceeding total sugar', () => {
    const issues = validatePanelFields({ sugar_g: 3, added_sugar_g: 10 });
    expect(issues.some((i) => i.field === 'added_sugar_g')).toBe(true);
  });

  it('rejects calories far outside the 4/4/9 macro band', () => {
    // 4*0 + 4*0 + 9*0 = 0 computed; stated 500 is nowhere near any loose band.
    const issues = validatePanelFields({ calories: 500, protein_g: 0, carbs_g: 0, fat_g: 0 });
    expect(issues.some((i) => i.field === 'calories')).toBe(true);
  });

  it('permits calories within the loose band', () => {
    // computed = 4*10 + 4*20 + 9*5 = 165; stated 170 is well within band.
    expect(validatePanelFields({ calories: 170, protein_g: 10, carbs_g: 20, fat_g: 5 })).toEqual([]);
  });

  it('does NOT fight a real label that legitimately misses the macro band (sugar alcohols / fiber / small-serving rounding)', () => {
    // A high-fiber, sugar-alcohol-sweetened bar: computed 4/4/9 overstates the
    // energy because sugar alcohols run ~2 kcal/g and fiber is excluded from
    // the Atwater sum on the label. computed = 4*10 + 4*30 + 9*8 = 232; a real
    // label might state something meaningfully lower.
    const issues = validatePanelFields({ calories: 170, protein_g: 10, carbs_g: 30, fat_g: 8 });
    expect(issues.some((i) => i.field === 'calories')).toBe(false);
  });

  it('skips a relationship check when a needed field is unknown (null is never treated as 0)', () => {
    expect(validatePanelFields({ fat_g: null, sat_fat_g: 5 })).toEqual([]);
    expect(validatePanelFields({ calories: 500, protein_g: null, carbs_g: 20, fat_g: 5 })).toEqual([]);
  });

  it('the tolerance constants are the loose band described in the spec', () => {
    expect(CALORIE_BAND_PCT).toBeGreaterThanOrEqual(0.2);
    expect(CALORIE_BAND_FLOOR).toBeGreaterThanOrEqual(30);
  });
});
