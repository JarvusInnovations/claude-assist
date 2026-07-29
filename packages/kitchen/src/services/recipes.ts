/**
 * Deterministic recipe macro computation. Never goes through a model —
 * "deterministic beats estimated when quantities are known"
 * (specs/modules/kitchen.md § Principles). Component quantities default to
 * the recipe's own `default_qty_g` when the entry didn't specify one.
 */

import { NUTRITION_FIELD_KEYS } from '../types.js';
import type { ComponentQuantity, NutritionFields, RecipeComponentMacros, RecipeRecord } from '../types.js';

/**
 * Round to one decimal place. Exported so other deterministic macro math
 * (e.g. `services/inventory.ts`'s consume-from-inventory macro scaling,
 * claude-assist#110) rounds the same way instead of re-deriving it.
 */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The panel keys a recipe component's per_100g reference can carry
 * (§ Nutrition panel) — the canonical list, not a second copy of it, so a new
 * panel field is summed here the moment it exists.
 */
const COMPONENT_PANEL_KEYS: readonly (keyof RecipeComponentMacros)[] = NUTRITION_FIELD_KEYS;

/**
 * Sum per-component nutrition scaled by (quantity_g / 100) against each
 * component's per_100g reference, across the FULL nine-field panel
 * (§ Nutrition panel — the completeness rule). Per-field null semantics: a
 * component that omits a field contributes "unknown" to that field, and the
 * field's total is null only when NO component carried it — never coerced to
 * 0 (unknown must not read as "zero of it"). `calories`/`protein_g`/
 * `sat_fat_g` are required per component by the contract; the rest are
 * optional additive extensions (contracts/meal-template.v1.schema.json).
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
      sugar_g: null,
      added_sugar_g: null,
      fiber_g: null,
      sodium_mg: null,
      confidence: 1,
      portion_basis: 'recipe-computed (no components)',
    };
  }

  const qtyByLabel = new Map((quantities ?? []).map((q) => [q.label, q.quantity_g]));

  const totals = new Map<keyof RecipeComponentMacros, number>();
  for (const component of recipe.components) {
    const qtyG = qtyByLabel.get(component.label) ?? component.default_qty_g;
    const factor = qtyG / 100;
    for (const key of COMPONENT_PANEL_KEYS) {
      const per100 = component.per_100g[key];
      if (typeof per100 !== 'number') continue; // unknown for this component — not zero
      totals.set(key, (totals.get(key) ?? 0) + per100 * factor);
    }
  }

  const field = (key: keyof RecipeComponentMacros): number | null => {
    const sum = totals.get(key);
    return sum === undefined ? null : round1(sum);
  };

  return {
    calories: field('calories'),
    protein_g: field('protein_g'),
    fat_g: field('fat_g'),
    sat_fat_g: field('sat_fat_g'),
    carbs_g: field('carbs_g'),
    sugar_g: field('sugar_g'),
    // A component that omits added sugar leaves the recipe's total unknown for
    // it — never 0 (§ Filling `added_sugar_g`: whole foods must ASSERT zero).
    added_sugar_g: field('added_sugar_g'),
    fiber_g: field('fiber_g'),
    sodium_mg: field('sodium_mg'),
    // Deterministic — a kitchen-scale user's numbers are exact by construction.
    confidence: 1,
    portion_basis: 'recipe-computed',
  };
}
