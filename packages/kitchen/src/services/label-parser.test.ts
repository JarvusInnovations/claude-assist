import { describe, expect, it } from 'bun:test';
import { convertNetContent, derivePer100gFromServing } from './label-parser.js';

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

  it('scales the panel added-sugar line with the rest (labels are authoritative)', () => {
    // "Total Sugars 12g / Includes 9g Added Sugars" on a 40 g serving.
    const derived = derivePer100gFromServing(40, { calories: 160, sugar_g: 12, added_sugar_g: 9 });
    expect(derived!.sugar_g).toBeCloseTo(30, 1);
    expect(derived!.added_sugar_g).toBeCloseTo(22.5, 1);
  });

  it('keeps an added-sugar 0 as 0 and an unread one as null', () => {
    // A legible panel with no Added Sugars line prints 0 (the ABSENT LINE = 0
    // rule); a panel that could not be read at all leaves it unknown. The two
    // must not collapse into each other through the scaling step.
    const zero = derivePer100gFromServing(50, { calories: 100, sugar_g: 4, added_sugar_g: 0 });
    expect(zero!.added_sugar_g).toBe(0);
    const unknown = derivePer100gFromServing(50, { calories: 100, sugar_g: 4 });
    expect(unknown!.added_sugar_g).toBeNull();
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

describe('convertNetContent (§ Prices divisor — code converts, never the model)', () => {
  it('converts weight units to grams (the 16 oz → 453.6 g class of cases)', () => {
    expect(convertNetContent({ value: 454, unit: 'g' })).toEqual({ net_content_g: 454, net_content_ml: null });
    expect(convertNetContent({ value: 16, unit: 'oz' })).toEqual({ net_content_g: 453.6, net_content_ml: null });
    expect(convertNetContent({ value: 1, unit: 'lb' })).toEqual({ net_content_g: 453.6, net_content_ml: null });
    expect(convertNetContent({ value: 1.36, unit: 'kg' })).toEqual({ net_content_g: 1360, net_content_ml: null });
  });

  it('converts volume units to ml, keeping the axes separate', () => {
    expect(convertNetContent({ value: 64, unit: 'fl oz' })).toEqual({ net_content_g: null, net_content_ml: 1892.7 });
    expect(convertNetContent({ value: 1, unit: 'L' })).toEqual({ net_content_g: null, net_content_ml: 1000 });
  });

  it('unknown/count units and null yield both-null (never guessed)', () => {
    expect(convertNetContent({ value: 12, unit: 'ct' })).toEqual({ net_content_g: null, net_content_ml: null });
    expect(convertNetContent(null)).toEqual({ net_content_g: null, net_content_ml: null });
  });
});
