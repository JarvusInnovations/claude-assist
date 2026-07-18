/**
 * Deterministic recipe macro computation. Never goes through a model —
 * "deterministic beats estimated when quantities are known"
 * (specs/modules/kitchen.md § Principles). Component quantities default to
 * the recipe's own `default_qty_g` when the entry didn't specify one.
 */

import type { ComponentQuantity, NutritionFields, RecipeRecord } from '../types.js';

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Sum per-component macros scaled by (quantity_g / 100) against each
 * component's per_100g reference. Fields the recipe schema doesn't carry
 * (fat_g overall, carbs_g, sodium_mg) stay null — the contract only
 * requires calories/protein_g/sat_fat_g per component (see
 * contracts/meal-record.v1.schema.json).
 */
export function computeRecipeMacros(
  recipe: RecipeRecord,
  quantities?: ComponentQuantity[]
): NutritionFields {
  if (recipe.components.length === 0) {
    return {
      calories: null,
      protein_g: null,
      fat_g: null,
      sat_fat_g: null,
      carbs_g: null,
      sodium_mg: null,
      confidence: 1,
      portion_basis: 'recipe-computed (no components)',
    };
  }

  const qtyByLabel = new Map((quantities ?? []).map((q) => [q.label, q.quantity_g]));

  let calories = 0;
  let protein = 0;
  let satFat = 0;
  for (const component of recipe.components) {
    const qtyG = qtyByLabel.get(component.label) ?? component.default_qty_g;
    const factor = qtyG / 100;
    calories += component.per_100g.calories * factor;
    protein += component.per_100g.protein_g * factor;
    satFat += component.per_100g.sat_fat_g * factor;
  }

  return {
    calories: round1(calories),
    protein_g: round1(protein),
    fat_g: null,
    sat_fat_g: round1(satFat),
    carbs_g: null,
    sodium_mg: null,
    // Deterministic — a kitchen-scale user's numbers are exact by construction.
    confidence: 1,
    portion_basis: 'recipe-computed',
  };
}
