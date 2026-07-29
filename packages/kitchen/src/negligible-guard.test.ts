/**
 * The `nutrition_negligible` sodium guard (specs/modules/kitchen.md
 * § Nutritionally negligible products — § Sodium is the exception that breaks
 * the marker).
 *
 * The discriminating pair is the whole point and leads the suite: garlic powder
 * qualifies, garlic salt does not. Every product named here is a generic food
 * category, never a brand.
 */

import { describe, expect, it } from 'bun:test';
import {
  checkNegligible,
  negligibleRefusalMessage,
  NEGLIGIBLE_SODIUM_MAX_PER_100G,
  NEGLIGIBLE_SODIUM_MAX_PER_SERVING,
} from './negligible-guard.js';

describe('checkNegligible — the discriminating pair', () => {
  it('permits garlic powder', () => {
    expect(checkNegligible({ name: 'Garlic Powder' })).toBeNull();
  });

  it('refuses garlic salt, which reads identically to a name filter', () => {
    const refusal = checkNegligible({ name: 'Garlic Salt' });
    expect(refusal?.code).toBe('name_salt');
  });
});

describe('checkNegligible — the name tier', () => {
  it.each([
    'Salt',
    'Table Salt',
    'Kosher Salt',
    'Sea Salt, Fine Grind',
    'Celery Salt',
    'Onion Salt',
    'Seasoned Salt',
    'Chicken Bouillon Powder',
    'MSG',
    'Monosodium Glutamate',
    'Baking Soda',
    'Baking Powder',
    'Sodium Bicarbonate',
    'Soy Sauce',
    'Fish Sauce',
  ])('refuses %s', (name) => {
    expect(checkNegligible({ name })?.code).toBe('name_salt');
  });

  it.each([
    'Garlic Powder',
    'Onion Powder',
    'Smoked Paprika',
    'Ground Black Pepper',
    'Dried Oregano',
    'Ground Cinnamon',
    'Curry Powder',
    'Chili Powder',
    'Vanilla Extract',
    'White Vinegar',
    'Ground Coffee',
    // "unsalted" contains the letters but never the word — the word-boundary
    // match must not fire inside it.
    'Unsalted Butter Flavoring',
  ])('permits %s', (name) => {
    expect(checkNegligible({ name })).toBeNull();
  });

  it.each([
    'Salt-Free Seasoning Blend',
    'Salt Free All Purpose Seasoning',
    'No Salt Added Seasoning',
    'Saltless Herb Blend',
    'Salt Substitute',
  ])('permits %s — a denial of salt, not a declaration of it', (name) => {
    expect(checkNegligible({ name })).toBeNull();
  });

  it('reads the aliases too, since a receipt spelling may be the salty one', () => {
    const refusal = checkNegligible({ name: 'House Seasoning', aliases: ['SEASONED SALT'] });
    expect(refusal?.code).toBe('name_salt');
    expect(refusal?.evidence).toContain('SEASONED SALT');
  });
});

describe('checkNegligible — the ingredients tier', () => {
  it('refuses a blend whose NAME says nothing but whose ingredients start with salt', () => {
    const refusal = checkNegligible({
      name: 'Poultry Seasoning',
      ingredients: 'Salt, dehydrated garlic, black pepper, paprika, thyme',
    });
    expect(refusal?.code).toBe('ingredients_salt');
  });

  it('refuses when the ingredients spell it as sodium chloride', () => {
    const refusal = checkNegligible({
      name: 'Steak Rub',
      ingredients: 'Spices, sodium chloride, dehydrated onion',
    });
    expect(refusal?.code).toBe('ingredients_salt');
  });

  it('permits an ingredients list that denies salt', () => {
    expect(
      checkNegligible({ name: 'Herb Blend', ingredients: 'Salt-free blend of oregano, basil, and thyme' })
    ).toBeNull();
  });

  it('permits a salt-free ingredients list', () => {
    expect(checkNegligible({ name: 'Ground Cumin', ingredients: 'Ground cumin seed' })).toBeNull();
  });
});

describe('checkNegligible — the known-sodium tier', () => {
  it('refuses a stated per-100g sodium over the ceiling', () => {
    const refusal = checkNegligible({
      name: 'Mystery Seasoning',
      nutrition_per_100g: { sodium_mg: 26_000 },
    });
    expect(refusal?.code).toBe('sodium_known');
    expect(refusal?.evidence).toContain('26000 mg sodium per 100 g');
  });

  it('permits a stated per-100g sodium at the ceiling — it is a ceiling, not a limit line', () => {
    expect(
      checkNegligible({ name: 'Mystery Seasoning', nutrition_per_100g: { sodium_mg: NEGLIGIBLE_SODIUM_MAX_PER_100G } })
    ).toBeNull();
  });

  it('normalizes a per-serving figure through the serving size', () => {
    // 590 mg in a 1.4 g serving is ~42,000 mg/100 g.
    const refusal = checkNegligible({
      name: 'Mystery Seasoning',
      nutrition_per_serving: { sodium_mg: 590 },
      serving_size_g: 1.4,
    });
    expect(refusal?.code).toBe('sodium_known');
    expect(refusal?.evidence).toContain('mg/100 g');
  });

  it('falls back to a per-serving ceiling when the serving size is unreadable', () => {
    expect(
      checkNegligible({
        name: 'Mystery Seasoning',
        nutrition_per_serving: { sodium_mg: NEGLIGIBLE_SODIUM_MAX_PER_SERVING + 1 },
      })?.code
    ).toBe('sodium_known');
    expect(
      checkNegligible({
        name: 'Mystery Seasoning',
        nutrition_per_serving: { sodium_mg: NEGLIGIBLE_SODIUM_MAX_PER_SERVING },
      })
    ).toBeNull();
  });

  it('ignores a null or absent sodium rather than treating it as zero', () => {
    expect(checkNegligible({ name: 'Ground Ginger', nutrition_per_100g: { sodium_mg: null } })).toBeNull();
    expect(checkNegligible({ name: 'Ground Ginger', nutrition_per_100g: { calories: 335 } })).toBeNull();
  });

  it('does not let a low stated sodium vouch for a salt-shaped name', () => {
    // No tier grants permission — a product with a readable panel never needed
    // the marker, so refusing here costs nothing.
    expect(checkNegligible({ name: 'Garlic Salt', nutrition_per_100g: { sodium_mg: 10 } })?.code).toBe('name_salt');
  });
});

describe('negligibleRefusalMessage', () => {
  it('names the food, the evidence, the rule, and the way through', () => {
    const message = negligibleRefusalMessage('Garlic Salt', checkNegligible({ name: 'Garlic Salt' })!);
    expect(message).toContain('Garlic Salt');
    expect(message).toContain('sodium');
    expect(message).toContain('Garlic powder qualifies; garlic salt does not');
    expect(message).toContain('nutrition_negligible_override: true');
  });
});
