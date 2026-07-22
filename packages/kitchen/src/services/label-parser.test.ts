import { describe, expect, it } from 'bun:test';
import { derivePer100gFromServing } from './label-parser.js';

describe('derivePer100gFromServing (§ Nutrition panel — capture raw, scale late)', () => {
  it('derives per-100g deterministically from the printed per-serving panel', () => {
    // The classic error case the model used to flub: 230 mg sodium per 55 g serving.
    const derived = derivePer100gFromServing(55, {
      calories: 150,
      protein_g: 5,
      fat_g: 6,
      sat_fat_g: 1,
      carbs_g: 20,
      sugar_g: 3,
      fiber_g: 2,
      sodium_mg: 230,
    });
    expect(derived!.sodium_mg).toBeCloseTo(418.2, 1); // 230 / 55 × 100
    expect(derived!.calories).toBeCloseTo(272.7, 1);
    expect(derived!.fiber_g).toBeCloseTo(3.6, 1);
  });

  it('a null per-serving field stays null in the derivation (unknown, never 0)', () => {
    const derived = derivePer100gFromServing(100, { calories: 100, protein_g: null, sodium_mg: 50 });
    expect(derived!.calories).toBe(100);
    expect(derived!.protein_g).toBeNull();
    expect(derived!.sodium_mg).toBe(50);
  });

  it('returns null (fall back to the transcribed per-100g column) without usable serving data', () => {
    expect(derivePer100gFromServing(null, { calories: 100 })).toBeNull();
    expect(derivePer100gFromServing(0, { calories: 100 })).toBeNull();
    expect(derivePer100gFromServing(55, null)).toBeNull();
  });
});
