import { describe, expect, it } from 'bun:test';
import { computeRecipeMacros } from './recipes.js';
import type { RecipeRecord } from '../types.js';

function mkRecipe(over: Partial<RecipeRecord> = {}): RecipeRecord {
  return {
    ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    name: 'Chicken rice bowl',
    components: [
      { label: 'chicken breast', default_qty_g: 150, per_100g: { calories: 165, protein_g: 31, sat_fat_g: 1 } },
      { label: 'white rice', default_qty_g: 200, per_100g: { calories: 130, protein_g: 2.7, sat_fat_g: 0.1 } },
    ],
    source: 'pushed',
    created_at: new Date(),
    updated_at: new Date(),
    archived_at: null,
    ...over,
  };
}

describe('computeRecipeMacros', () => {
  it('sums per-component macros scaled by default quantities when none are given', () => {
    const result = computeRecipeMacros(mkRecipe());
    // chicken: 165*1.5=247.5, protein 31*1.5=46.5, satfat 1*1.5=1.5
    // rice: 130*2=260, protein 2.7*2=5.4, satfat 0.1*2=0.2
    expect(result.calories).toBeCloseTo(507.5, 1);
    expect(result.protein_g).toBeCloseTo(51.9, 1);
    expect(result.sat_fat_g).toBeCloseTo(1.7, 1);
    expect(result.confidence).toBe(1);
    expect(result.portion_basis).toBe('recipe-computed');
  });

  it('is deterministic — a kitchen-scale users numbers are exact by construction', () => {
    const a = computeRecipeMacros(mkRecipe());
    const b = computeRecipeMacros(mkRecipe());
    expect(a).toEqual(b);
  });

  it('uses logged component quantities over recipe defaults when provided', () => {
    const result = computeRecipeMacros(mkRecipe(), [
      { label: 'chicken breast', quantity_g: 100 },
      { label: 'white rice', quantity_g: 100 },
    ]);
    expect(result.calories).toBeCloseTo(165 + 130, 1);
    expect(result.protein_g).toBeCloseTo(31 + 2.7, 1);
  });

  it('falls back to the recipe default for any component missing from the logged quantities', () => {
    const result = computeRecipeMacros(mkRecipe(), [{ label: 'chicken breast', quantity_g: 100 }]);
    // chicken uses the logged 100g; rice falls back to its 200g default
    expect(result.calories).toBeCloseTo(165 + 260, 1);
  });

  it('returns nulls for an empty-component recipe rather than zeros', () => {
    const result = computeRecipeMacros(mkRecipe({ components: [] }));
    expect(result.calories).toBeNull();
    expect(result.protein_g).toBeNull();
    expect(result.confidence).toBe(1);
  });
});

describe('computeRecipeMacros — full panel (§ Nutrition panel)', () => {
  it('sums every panel field a component carries; a field is null only when NO component carried it', () => {
    const recipe = mkRecipe({
      components: [
        {
          label: 'oats',
          default_qty_g: 50,
          per_100g: {
            calories: 375, protein_g: 13, sat_fat_g: 1.2,
            fat_g: 7.3, carbs_g: 68.8, sugar_g: 2.1, fiber_g: 8.3, sodium_mg: 0,
          },
        },
        // Carries fat/carbs but NOT sugar/fiber/sodium — those stay unknown
        // for this component, not zero.
        { label: 'soymilk', default_qty_g: 150, per_100g: { calories: 33, protein_g: 3.3, sat_fat_g: 0.2, fat_g: 1.7, carbs_g: 1.3 } },
      ],
    });
    const result = computeRecipeMacros(recipe);
    expect(result.calories).toBeCloseTo(237, 0);
    expect(result.fat_g).toBeCloseTo(7.3 * 0.5 + 1.7 * 1.5, 1);
    expect(result.carbs_g).toBeCloseTo(68.8 * 0.5 + 1.3 * 1.5, 1);
    // Sugar/fiber/sodium: only the oats carried them — their totals are the
    // oats' contribution alone (the soymilk's share is unknown, not 0).
    expect(result.sugar_g).toBe(1.1); // round1(2.1 × 0.5)
    expect(result.fiber_g).toBeCloseTo(8.3 * 0.5, 1);
    expect(result.sodium_mg).toBe(0); // oats genuinely carry 0 — a real zero survives
  });

  it('legacy three-field components leave the extended panel null, never 0', () => {
    const result = computeRecipeMacros(mkRecipe()); // default components carry only cal/protein/satfat
    expect(result.calories).not.toBeNull();
    expect(result.fat_g).toBeNull();
    expect(result.carbs_g).toBeNull();
    expect(result.sugar_g).toBeNull();
    expect(result.fiber_g).toBeNull();
    expect(result.sodium_mg).toBeNull();
  });
});

describe('computeRecipeMacros — added_sugar_g null-vs-zero summing', () => {
  it('sums an asserted 0 alongside a real contribution; unknown stays unknown', () => {
    const recipe = mkRecipe({
      components: [
        // A whole-food component ASSERTS zero added sugar — it contributes a
        // real 0 to the total rather than making the field unknown.
        {
          label: 'plain oats',
          default_qty_g: 100,
          per_100g: {
            calories: 375, protein_g: 13, sat_fat_g: 1.2,
            sugar_g: 2, added_sugar_g: 0,
          },
        },
        // A sweetened component carries a real number.
        {
          label: 'sweetened topping',
          default_qty_g: 50,
          per_100g: {
            calories: 300, protein_g: 1, sat_fat_g: 0.5,
            sugar_g: 40, added_sugar_g: 30,
          },
        },
      ],
    });
    const result = computeRecipeMacros(recipe);
    expect(result.sugar_g).toBeCloseTo(2 + 40 * 0.5, 1);
    expect(result.added_sugar_g).toBe(15); // 0 + round1(30 × 0.5)
  });

  it('a component omitting added sugar contributes UNKNOWN, not zero', () => {
    const recipe = mkRecipe({
      components: [
        {
          label: 'sweetened topping',
          default_qty_g: 100,
          per_100g: { calories: 300, protein_g: 1, sat_fat_g: 0.5, sugar_g: 40, added_sugar_g: 30 },
        },
        // Omits added sugar entirely: unknown for this component. The total is
        // still the known contribution — never inflated to include a guessed 0
        // and never nulled out by the omission.
        { label: 'mystery mix', default_qty_g: 100, per_100g: { calories: 200, protein_g: 5, sat_fat_g: 1, sugar_g: 10 } },
      ],
    });
    const result = computeRecipeMacros(recipe);
    expect(result.sugar_g).toBe(50);
    expect(result.added_sugar_g).toBe(30);
  });

  it('is null when NO component carried it — the whole field is unknown', () => {
    const recipe = mkRecipe({
      components: [
        { label: 'a', default_qty_g: 100, per_100g: { calories: 100, protein_g: 5, sat_fat_g: 1, sugar_g: 5 } },
        { label: 'b', default_qty_g: 100, per_100g: { calories: 120, protein_g: 6, sat_fat_g: 2, sugar_g: 6 } },
      ],
    });
    const result = computeRecipeMacros(recipe);
    expect(result.sugar_g).toBe(11);
    expect(result.added_sugar_g).toBeNull();
    expect(result.added_sugar_g).not.toBe(0);
  });

  it('an all-whole-food recipe totals a genuine 0, not null', () => {
    const recipe = mkRecipe({
      components: [
        { label: 'chicken', default_qty_g: 150, per_100g: { calories: 165, protein_g: 31, sat_fat_g: 1, sugar_g: 0, added_sugar_g: 0 } },
        { label: 'broccoli', default_qty_g: 200, per_100g: { calories: 35, protein_g: 2.4, sat_fat_g: 0, sugar_g: 1.7, added_sugar_g: 0 } },
      ],
    });
    expect(computeRecipeMacros(recipe).added_sugar_g).toBe(0);
  });
});
