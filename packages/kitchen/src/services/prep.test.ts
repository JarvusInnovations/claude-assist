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
  return {
    async getProduct(ulid: string) {
      return products[ulid] ?? null;
    },
    async getItem(ulid: string) {
      return items[ulid] ?? null;
    },
  } as any;
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
