import { describe, it, expect } from 'bun:test';
import { PrepService, PrepValidationError, plannedTotals } from './prep.js';

/**
 * specs/modules/kitchen.md § Authoring a prep worksheet.
 *
 * The point of the command is that per_basis blocks come from the CATALOG, not
 * from a hand-written definition — so the tests that matter are the ones that
 * pin where the numbers come from and what happens when they are missing.
 */

const PANEL = {
  calories: 52.9,
  protein_g: 10.6,
  fat_g: 0,
  sat_fat_g: 0,
  carbs_g: 2.9,
  sugar_g: 2.9,
  added_sugar_g: 0,
  fiber_g: 0,
  sodium_mg: 38.2,
};

function fakeStore(overrides: Partial<Record<string, any>> = {}) {
  const products: Record<string, any> = {
    prod_yogurt: { ulid: 'prod_yogurt', name: 'Nonfat Greek yogurt', nutrition_per_100g: PANEL },
    prod_partial: {
      ulid: 'prod_partial',
      name: 'Half-panelled thing',
      // Deliberately missing sodium_mg and fiber_g.
      nutrition_per_100g: { calories: 100, protein_g: 5 },
    },
    prod_nopanel: { ulid: 'prod_nopanel', name: 'Unscanned thing', nutrition_per_100g: null },
    ...(overrides.products ?? {}),
  };
  const items: Record<string, any> = {
    item_linked: { ulid: 'item_linked', product_ulid: 'prod_yogurt' },
    item_unlinked: { ulid: 'item_unlinked', product_ulid: null },
    ...(overrides.items ?? {}),
  };
  const derivations: Record<string, any> = { ...(overrides.derivations ?? {}) };
  return {
    async getProduct(ulid: string) {
      return products[ulid] ?? null;
    },
    async getItem(ulid: string) {
      return items[ulid] ?? null;
    },
    async getDerivationsByDerivedItemUlids(ulids: string[]) {
      const map = new Map<string, any>();
      for (const ulid of ulids) if (derivations[ulid]) map.set(ulid, derivations[ulid]);
      return map;
    },
  } as any;
}

/**
 * A `resolveRecipe` function, as `PrepService`'s fourth constructor argument
 * — deliberately a bare function, not a `RecipeStore`, since it stands in
 * for the merged (sheet + pushed + promoted) resolver `consume` uses
 * (§ A derived component resolves through its recipe, not a product), never
 * the DB-only `RecipeStore` `fakeRecipes` above stands in for.
 */
function fakeResolveRecipe(recipes: Record<string, any> = {}) {
  const all: Record<string, any> = {
    rec_egg: {
      ulid: 'rec_egg',
      name: 'Hard-boiled egg',
      components: [{ label: 'egg', default_qty_g: 50, per_100g: { calories: 155, protein_g: 12.6, sat_fat_g: 3.3 } }],
    },
    rec_jar: {
      ulid: 'rec_jar',
      name: 'Overnight oats jar',
      components: [
        { label: 'oats', default_qty_g: 80, per_100g: { calories: 389, protein_g: 16.9, sat_fat_g: 1.9 } },
        { label: 'yogurt', default_qty_g: 100, per_100g: { calories: 59, protein_g: 10.3, sat_fat_g: 0.1 } },
      ],
    },
    rec_empty2: { ulid: 'rec_empty2', name: 'Empty', components: [] },
    ...recipes,
  };
  return async (ulid: string) => all[ulid] ?? null;
}

function fakeRecipes(recipes: Record<string, any> = {}) {
  return {
    async get(ulid: string) {
      return (
        {
          rec_bowl: {
            ulid: 'rec_bowl',
            name: 'Grain bowl',
            components: [
              { label: 'cooked grain', default_qty_g: 185, per_100g: { calories: 150, protein_g: 4.5, sat_fat_g: 0.2 } },
              { label: 'dressing', default_qty_g: 30, per_100g: { calories: 400, protein_g: 0, sat_fat_g: 6, sodium_mg: 12 } },
            ],
          },
          rec_empty: { ulid: 'rec_empty', name: 'Empty', components: [] },
          ...recipes,
        } as Record<string, any>
      )[ulid] ?? null;
    },
  } as any;
}

function fakePublisher() {
  const calls: any[] = [];
  return {
    calls,
    publisher: {
      async publish(input: any) {
        calls.push(input);
        return { slug: input.slug, url: `/pages/${input.slug}`, created: true, versionId: 1 };
      },
    } as any,
  };
}

describe('PrepService.publish', () => {
  it('reads per_basis from the catalog rather than accepting stated macros', async () => {
    const { publisher, calls } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher);

    const result = await svc.publish({
      slug: 'lunch',
      label: 'Yogurt bowl',
      components: [{ product_ulid: 'prod_yogurt', quantity: 170 }],
    });

    const definition = calls[0].worksheet;
    expect(definition.kind).toBe('worksheet');
    expect(definition.basis).toBe(100);
    // Exactly the stored panel — no rescaling, no recall.
    expect(definition.components[0].per_basis.calories).toBe(52.9);
    expect(definition.components[0].per_basis.sodium_mg).toBe(38.2);
    expect(definition.components[0].label).toBe('Nonfat Greek yogurt');
    // 170 g of a 52.9/100g panel.
    expect(result.planned_totals.calories).toBe(90);
    expect(result.planned_totals.protein_g).toBe(18);
  });

  it('resolves --component-item through to the linked product', async () => {
    const { publisher, calls } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher);
    await svc.publish({
      slug: 'lunch',
      label: 'Bowl',
      components: [{ item_ulid: 'item_linked', quantity: 100 }],
    });
    expect(calls[0].worksheet.components[0].per_basis.calories).toBe(52.9);
  });

  it('REFUSES a product with no panel rather than guessing', async () => {
    const { publisher } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher);
    await expect(
      svc.publish({ slug: 'x', label: 'x', components: [{ product_ulid: 'prod_nopanel', quantity: 10 }] })
    ).rejects.toThrow(PrepValidationError);
  });

  it('refuses an item with no product link', async () => {
    const { publisher } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher);
    await expect(
      svc.publish({ slug: 'x', label: 'x', components: [{ item_ulid: 'item_unlinked', quantity: 10 }] })
    ).rejects.toThrow(/no linked product/);
  });

  it('omits a missing field so it totals UNKNOWN, never zero', async () => {
    const { publisher, calls } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher);
    const result = await svc.publish({
      slug: 'x',
      label: 'x',
      components: [{ product_ulid: 'prod_partial', quantity: 200 }],
    });

    expect(calls[0].worksheet.components[0].per_basis).not.toHaveProperty('sodium_mg');
    expect(result.planned_totals.sodium_mg).toBeNull();
    expect(result.planned_totals.fiber_g).toBeNull();
    expect(result.unknown_fields).toContain('sodium_mg');
    // A field that IS carried still totals normally.
    expect(result.planned_totals.calories).toBe(200);
  });

  it('emits cook_mode with the sheet label, and packed extras only when packed', async () => {
    const { publisher, calls } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher);

    await svc.publish({
      slug: 'jars',
      label: 'Overnight oats',
      components: [{ product_ulid: 'prod_yogurt', quantity: 240 }],
      cook: { disposition: 'packed', units: 3, shelf_life_class: 'prepared' },
    });
    expect(calls[0].worksheet.cook_mode).toEqual({
      disposition: 'packed',
      label: 'Overnight oats',
      units: 3,
      shelf_life_class: 'prepared',
    });

    await svc.publish({
      slug: 'lunch',
      label: 'Bowl',
      components: [{ product_ulid: 'prod_yogurt', quantity: 100 }],
      cook: { disposition: 'eaten' },
    });
    expect(calls[1].worksheet.cook_mode).toEqual({ disposition: 'eaten', label: 'Bowl' });
  });

  it('requires exactly one of product_ulid / item_ulid', async () => {
    const { publisher } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher);
    await expect(
      svc.publish({ slug: 'x', label: 'x', components: [{ quantity: 10 }] })
    ).rejects.toThrow(/exactly one/);
    await expect(
      svc.publish({
        slug: 'x',
        label: 'x',
        components: [{ product_ulid: 'prod_yogurt', item_ulid: 'item_linked', quantity: 10 }],
      })
    ).rejects.toThrow(/exactly one/);
  });
});

describe('plannedTotals', () => {
  it('is a preview using the SAME formula the module computes on submit', () => {
    const { totals } = plannedTotals([
      { quantity: 170, per_basis: { calories: 52.9, protein_g: 10.6 } },
      { quantity: 50, per_basis: { calories: 155, protein_g: 12.6 } },
    ]);
    // 170/100*52.9 + 50/100*155 = 89.93 + 77.5 = 167.43 → 167 at precision 0
    expect(totals.calories).toBe(167);
    expect(totals.protein_g).toBe(24.3);
  });

  it('returns null only when NO component carried the field', () => {
    const { totals, unknown } = plannedTotals([
      { quantity: 100, per_basis: { calories: 10 } },
      { quantity: 100, per_basis: { calories: 10, fiber_g: 2 } },
    ]);
    expect(totals.calories).toBe(20);
    // One carrier is enough — the other contributes unknown, not zero.
    expect(totals.fiber_g).toBe(2);
    expect(totals.sodium_mg).toBeNull();
    expect(unknown).toContain('sodium_mg');
    expect(unknown).not.toContain('fiber_g');
  });
});


describe('--recipe seeding', () => {
  it('maps every recipe line onto a weighable row — nothing to skip', async () => {
    const { publisher, calls } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher, fakeRecipes());

    const result = await svc.publish({ slug: 'bowl', label: 'Grain bowl', recipe_ulid: 'rec_bowl' });

    const rows = calls[0].worksheet.components;
    expect(rows).toHaveLength(2);
    // default_qty_g becomes the planned quantity; per_100g becomes per_basis
    // directly — recipe lines carry their own reference values inline, so this
    // needs no catalog lookup at all.
    expect(rows[0]).toMatchObject({ label: 'cooked grain', quantity: 185 });
    expect(rows[0].per_basis.calories).toBe(150);
    expect(result.planned_totals.calories).toBe(398); // 185/100*150 + 30/100*400
  });

  it('applies the SAME null rule as catalog components', async () => {
    const { publisher } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher, fakeRecipes());
    const result = await svc.publish({ slug: 'bowl', label: 'Grain bowl', recipe_ulid: 'rec_bowl' });

    // Only the dressing states sodium; the grain omits it → one carrier, real total.
    expect(result.planned_totals.sodium_mg).toBe(4);
    // Neither line states fiber → unknown, never 0.
    expect(result.planned_totals.fiber_g).toBeNull();
    expect(result.unknown_fields).toContain('fiber_g');
  });

  it('appends explicit components AFTER the seeded ones', async () => {
    const { publisher, calls } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher, fakeRecipes());
    await svc.publish({
      slug: 'bowl',
      label: 'Grain bowl',
      recipe_ulid: 'rec_bowl',
      components: [{ product_ulid: 'prod_yogurt', quantity: 100 }],
    });
    const labels = calls[0].worksheet.components.map((c: any) => c.label);
    expect(labels).toEqual(['cooked grain', 'dressing', 'Nonfat Greek yogurt']);
  });

  it('refuses a missing or componentless recipe rather than publishing an empty sheet', async () => {
    const { publisher } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher, fakeRecipes());
    await expect(svc.publish({ slug: 'x', label: 'x', recipe_ulid: 'nope' })).rejects.toThrow(/recipe not found/);
    await expect(svc.publish({ slug: 'x', label: 'x', recipe_ulid: 'rec_empty' })).rejects.toThrow(/no components/);
  });

  it('still requires SOMETHING — no recipe and no components is an error', async () => {
    const { publisher } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher, fakeRecipes());
    await expect(svc.publish({ slug: 'x', label: 'x' })).rejects.toThrow(/at least one component/);
  });
});

describe('consume bindings (§ Eaten sheets decrement their sources)', () => {
  const withUnit = () =>
    fakeStore({
      products: {
        prod_egg: { ulid: 'prod_egg', name: 'Large eggs', nutrition_per_100g: { calories: 155, protein_g: 12.6 }, unit_edible_g: 50 },
        prod_nounit: { ulid: 'prod_nounit', name: 'Canned thing', nutrition_per_100g: { calories: 100 }, unit_edible_g: null },
      },
      items: { item_egg: { ulid: 'item_egg', product_ulid: 'prod_egg' }, item_can: { ulid: 'item_can', product_ulid: 'prod_nounit' } },
    });

  it('binds only ITEMS — a bare product is a catalog row, not stock', async () => {
    const { publisher, calls } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher);
    const result = await svc.publish({
      slug: 'x', label: 'x', cook: { disposition: 'eaten' },
      components: [
        { item_ulid: 'item_linked', quantity: 100 },
        { product_ulid: 'prod_yogurt', quantity: 50 },
      ],
    });
    const consumes = calls[0].worksheet.cook_mode.consumes;
    expect(consumes).toHaveLength(1);
    expect(consumes[0]).toMatchObject({ item_ulid: 'item_linked', model: 'divisible' });

    // claude-assist#207: the unbound (product-only) row must be VISIBLY
    // marked on the sheet itself — never look identical to the bound row.
    const rows = calls[0].worksheet.components;
    expect(rows[0].note).toBeUndefined(); // item-bound: nothing to warn about
    expect(rows[1].note).toMatch(/not tracked in stock/);
    expect(result.untracked_components).toEqual(['Nonfat Greek yogurt']);
  });

  it('does NOT mark a product-only component on a sheet with no --cook — nothing was promised', async () => {
    const { publisher, calls } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher);
    const result = await svc.publish({
      slug: 'x', label: 'x',
      components: [{ product_ulid: 'prod_yogurt', quantity: 50 }],
    });
    expect(calls[0].worksheet.components[0].note).toBeUndefined();
    expect(result.untracked_components).toEqual([]);
  });

  it('appends the untracked warning to an existing component note rather than replacing it', async () => {
    const { publisher, calls } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher);
    await svc.publish({
      slug: 'x', label: 'x', cook: { disposition: 'eaten' },
      components: [{ product_ulid: 'prod_yogurt', quantity: 50, note: 'a gift, not our stock' }],
    });
    const note: string = calls[0].worksheet.components[0].note;
    expect(note).toContain('a gift, not our stock');
    expect(note).toMatch(/not tracked in stock/);
  });

  it('marks an unbound component on a packed sheet the same way — packed components can decrement too', async () => {
    const { publisher, calls } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher);
    const result = await svc.publish({
      slug: 'x', label: 'x', cook: { disposition: 'packed', units: 2 },
      components: [{ product_ulid: 'prod_yogurt', quantity: 50 }],
    });
    expect(calls[0].worksheet.components[0].note).toMatch(/not tracked in stock/);
    expect(result.untracked_components).toEqual(['Nonfat Greek yogurt']);
  });

  it('states counted bindings and scales the panel by unit mass', async () => {
    const { publisher, calls } = fakePublisher();
    const svc = new PrepService(withUnit(), publisher);
    const result = await svc.publish({
      slug: 'x', label: 'x', cook: { disposition: 'eaten' },
      components: [{ item_ulid: 'item_egg', quantity: 2, counted: true }],
    });
    expect(calls[0].worksheet.cook_mode.consumes[0]).toMatchObject({ model: 'counted' });
    // 2 units x 50 g x 155/100 = 155 kcal — the human counts eggs, the panel
    // still comes out in real macros.
    expect(result.planned_totals.calories).toBe(155);
  });

  it('REFUSES a counted component with no unit_edible_g rather than deriving one', async () => {
    const { publisher } = fakePublisher();
    const svc = new PrepService(withUnit(), publisher);
    await expect(
      svc.publish({ slug: 'x', label: 'x', components: [{ item_ulid: 'item_can', quantity: 1, counted: true }] })
    ).rejects.toThrow(/unit_edible_g/);
  });

  it('emits bindings on a packed sheet too — a source fixed at publish cannot follow the submitted weight', async () => {
    const { publisher, calls } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher);
    await svc.publish({
      slug: 'x', label: 'x', cook: { disposition: 'packed', units: 3 },
      components: [{ item_ulid: 'item_linked', quantity: 100 }],
    });
    expect(calls[0].worksheet.cook_mode.consumes).toEqual([
      { component: expect.any(String), item_ulid: 'item_linked', model: 'divisible' },
    ]);
  });

  it('carries components_per through only when stated — the default reading is per-batch', async () => {
    const { publisher, calls } = fakePublisher();
    const svc = new PrepService(fakeStore(), publisher);
    await svc.publish({
      slug: 'x', label: 'x', cook: { disposition: 'packed', units: 3, components_per: 'unit' },
      components: [{ item_ulid: 'item_linked', quantity: 100 }],
    });
    expect(calls[0].worksheet.cook_mode.components_per).toBe('unit');

    await svc.publish({
      slug: 'y', label: 'y', cook: { disposition: 'packed', units: 3 },
      components: [{ item_ulid: 'item_linked', quantity: 100 }],
    });
    expect(calls[1].worksheet.cook_mode.components_per).toBeUndefined();
  });
});

describe('a derived component resolves through its recipe (claude-assist#199)', () => {
  it('resolves per_basis from the recipe for a counted derived item, matching a real macro figure', async () => {
    const { publisher, calls } = fakePublisher();
    const store = fakeStore({
      items: {
        item_egg_jar: { ulid: 'item_egg_jar', product_ulid: null, units_total: 3, raw_label: 'Hard-boiled egg jar' },
      },
      derivations: { item_egg_jar: { recipe_ulid: 'rec_egg' } },
    });
    const svc = new PrepService(store, publisher, undefined, fakeResolveRecipe());

    const result = await svc.publish({
      slug: 'eggs',
      label: 'Hard-boiled eggs',
      cook: { disposition: 'eaten' },
      components: [{ item_ulid: 'item_egg_jar', quantity: 2, counted: true }],
    });

    // One egg's recipe totals 50/100*155 = 77.5 kcal, 50/100*12.6 = 6.3 g
    // protein — the SAME numbers computeRecipeMacros gives a direct
    // recipe-logged entry (and consume's own derived-item channel). The
    // worksheet's per_basis is that total * 100 (basis fixed at 100), so 2
    // units on the sheet doubles it back out: 155 kcal, 12.6 g protein.
    expect(calls[0].worksheet.components[0].per_basis.calories).toBe(7750);
    expect(calls[0].worksheet.components[0].per_basis.protein_g).toBe(630);
    expect(result.planned_totals.calories).toBe(155);
    expect(result.planned_totals.protein_g).toBe(12.6);
    expect(calls[0].worksheet.components[0].label).toBe('Hard-boiled egg jar');
    expect(calls[0].worksheet.cook_mode.consumes[0]).toMatchObject({
      model: 'counted',
      item_ulid: 'item_egg_jar',
    });
  });

  it('sums each recipe component at its OWN default_qty_g, not a shared quantity', async () => {
    const { publisher, calls } = fakePublisher();
    const store = fakeStore({
      items: { item_jar: { ulid: 'item_jar', product_ulid: null, units_total: 3, raw_label: 'Oat jar' } },
      derivations: { item_jar: { recipe_ulid: 'rec_jar' } },
    });
    const svc = new PrepService(store, publisher, undefined, fakeResolveRecipe());

    const result = await svc.publish({
      slug: 'jars',
      label: 'Oat jars',
      components: [{ item_ulid: 'item_jar', quantity: 1, counted: true }],
    });

    // 80/100*389 + 100/100*59 = 311.2 + 59 = 370.2 kcal — each ingredient at
    // its OWN default_qty_g (80 g oats, 100 g yogurt), not both scaled by a
    // single shared quantity. per_basis is the exact total * 100.
    expect(calls[0].worksheet.components[0].per_basis.calories).toBe(37020);
    // 80/100*16.9 + 100/100*10.3 = 13.52 + 10.3 = 23.82 -> round1 -> 23.8.
    expect(result.planned_totals.protein_g).toBe(23.8);
  });

  it('REFUSES a derived item referenced with --component-item (grams) instead of --component-unit', async () => {
    const { publisher } = fakePublisher();
    const store = fakeStore({
      items: { item_egg_jar: { ulid: 'item_egg_jar', product_ulid: null, units_total: 3 } },
      derivations: { item_egg_jar: { recipe_ulid: 'rec_egg' } },
    });
    const svc = new PrepService(store, publisher, undefined, fakeResolveRecipe());
    await expect(
      svc.publish({ slug: 'x', label: 'x', components: [{ item_ulid: 'item_egg_jar', quantity: 50 }] })
    ).rejects.toThrow(/referenced as counted/);
  });

  it('REFUSES a fraction-modeled derived item even when referenced as counted', async () => {
    const { publisher } = fakePublisher();
    const store = fakeStore({
      items: { item_quinoa: { ulid: 'item_quinoa', product_ulid: null, units_total: null } },
    });
    const svc = new PrepService(store, publisher, undefined, fakeResolveRecipe());
    await expect(
      svc.publish({ slug: 'x', label: 'x', components: [{ item_ulid: 'item_quinoa', quantity: 1, counted: true }] })
    ).rejects.toThrow(/not a counted item/);
  });

  it('REFUSES a counted derived item whose derivation carries no recipe_ulid', async () => {
    const { publisher } = fakePublisher();
    // No `derivations` entry at all — never converted, or the row is missing.
    const store = fakeStore({ items: { item_mystery: { ulid: 'item_mystery', product_ulid: null, units_total: 2 } } });
    const svc = new PrepService(store, publisher, undefined, fakeResolveRecipe());
    await expect(
      svc.publish({ slug: 'x', label: 'x', components: [{ item_ulid: 'item_mystery', quantity: 1, counted: true }] })
    ).rejects.toThrow(/no recipe provenance/);
  });

  it('REFUSES when the linked recipe is missing or has no components', async () => {
    const { publisher } = fakePublisher();
    const store = fakeStore({
      items: {
        item_bad: { ulid: 'item_bad', product_ulid: null, units_total: 1 },
        item_emptyrecipe: { ulid: 'item_emptyrecipe', product_ulid: null, units_total: 1 },
      },
      derivations: {
        item_bad: { recipe_ulid: 'rec_missing' },
        item_emptyrecipe: { recipe_ulid: 'rec_empty2' },
      },
    });
    const svc = new PrepService(store, publisher, undefined, fakeResolveRecipe());
    await expect(
      svc.publish({ slug: 'x', label: 'x', components: [{ item_ulid: 'item_bad', quantity: 1, counted: true }] })
    ).rejects.toThrow(/was not found or has no components/);
    await expect(
      svc.publish({
        slug: 'x',
        label: 'x',
        components: [{ item_ulid: 'item_emptyrecipe', quantity: 1, counted: true }],
      })
    ).rejects.toThrow(/was not found or has no components/);
  });

  it('REFUSES when no recipe resolver is configured', async () => {
    const { publisher } = fakePublisher();
    const store = fakeStore({
      items: { item_egg_jar: { ulid: 'item_egg_jar', product_ulid: null, units_total: 3 } },
      derivations: { item_egg_jar: { recipe_ulid: 'rec_egg' } },
    });
    const svc = new PrepService(store, publisher); // no resolveRecipe injected
    await expect(
      svc.publish({ slug: 'x', label: 'x', components: [{ item_ulid: 'item_egg_jar', quantity: 1, counted: true }] })
    ).rejects.toThrow(/no recipe resolver/);
  });
});
