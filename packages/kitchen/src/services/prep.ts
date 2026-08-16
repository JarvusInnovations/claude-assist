/**
 * Prep-worksheet authoring (specs/modules/kitchen.md § Authoring a prep
 * worksheet). Turns catalog references into a worksheet definition and
 * publishes it through core's `PagePublisher` seam.
 *
 * **Why this lives in the kitchen module and not in the pages CLI.** A worksheet
 * definition for a meal is mostly `per_basis` blocks, and those are reference
 * values this module already stores. Assembling them anywhere else means
 * transcribing numbers by hand — the estimation-by-recall failure § Nutrition
 * panel exists to prevent, reappearing in the authoring path — and a hand-built
 * definition can silently disagree with the catalog it was copied from.
 *
 * Dependencies point ONE way: kitchen may reach the pages module through the
 * injected publisher; the pages module never reaches into a domain. That is the
 * mirror of the cook-mode sink, which carries a submission back the other way.
 */

import type { PagePublisher } from '@jarvus/claude-assist-core';
import type { InventoryStore } from '../inventory-store.js';
import type { RecipeStore } from '../store.js';
import type { NutritionPer100g } from '../inventory-types.js';
import type { NutritionFields, RecipeRecord } from '../types.js';
import { computeRecipeMacros } from './recipes.js';

/** The nine panel fields, in the order a sheet displays them. */
export const PREP_FIELDS: { key: keyof NutritionPer100g; label: string; unit?: string; precision: number }[] = [
  { key: 'calories', label: 'Calories', precision: 0 },
  { key: 'protein_g', label: 'Protein', unit: 'g', precision: 1 },
  { key: 'fat_g', label: 'Fat', unit: 'g', precision: 1 },
  { key: 'sat_fat_g', label: 'Sat fat', unit: 'g', precision: 1 },
  { key: 'carbs_g', label: 'Carbs', unit: 'g', precision: 1 },
  { key: 'sugar_g', label: 'Sugar', unit: 'g', precision: 1 },
  { key: 'added_sugar_g', label: 'Added sugar', unit: 'g', precision: 1 },
  { key: 'fiber_g', label: 'Fiber', unit: 'g', precision: 1 },
  { key: 'sodium_mg', label: 'Sodium', unit: 'mg', precision: 0 },
];

export class PrepValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrepValidationError';
  }
}

export interface PrepComponentRef {
  /** One of these two identifies the food. */
  product_ulid?: string;
  item_ulid?: string;
  /**
   * Planned quantity — a DEFAULT for the sheet, never a claim. Grams for a
   * divisible item; whole UNITS when `counted` (§ The basis rule).
   */
  quantity: number;
  /**
   * The item is counted, so `quantity` is units and its panel mass is
   * `units * unit_edible_g`. Stated, never inferred from the number.
   */
  counted?: boolean;
  /** Overrides the product name on the row. */
  label?: string;
  note?: string;
}

export interface PrepPublishInput {
  slug: string;
  label: string;
  /**
   * Seed components from a recipe's lines (§ Authoring a prep worksheet).
   * Recipe components already carry `default_qty_g` + `per_100g` inline, so they
   * map onto weighable rows directly — no product resolution, and nothing to
   * skip. Explicit `components` are appended after the seeded ones, so a sheet
   * can start from a recipe and add today's extras.
   */
  recipe_ulid?: string;
  title?: string;
  heading?: string;
  intro?: string;
  components?: PrepComponentRef[];
  steps?: string[];
  submit_label?: string;
  cook?: {
    disposition: 'eaten' | 'packed';
    units?: number;
    shelf_life_class?: string;
    recipe_ulid?: string;
    sources?: { item_ulid: string; amount?: number }[];
    /**
     * Do the component quantities describe ONE unit of the batch, or the whole
     * batch? Defaults to `batch`. Only meaningful alongside `units`.
     */
    components_per?: 'batch' | 'unit';
  };
  digest_optin?: boolean;
}

export interface PrepPublishResult {
  slug: string;
  url: string;
  created: boolean;
  /** Totals at the PLANNED quantities, so the author can sanity-check. */
  planned_totals: Record<string, number | null>;
  components: { label: string; quantity: number; per_basis: Record<string, number> }[];
  /** Fields no component carried — null totals, surfaced rather than hidden. */
  unknown_fields: string[];
}

export class PrepService {
  constructor(
    private store: InventoryStore,
    private publisher: PagePublisher,
    private recipes?: RecipeStore,
    /**
     * Resolves a derived component's panel (§ Authoring a prep worksheet
     * § A derived component resolves through its recipe, not a product). Must
     * be the SAME merged (sheet + pushed + promoted) universe `consume` reads
     * (§ Consume from inventory § Eligibility) — a narrower DB-only lookup
     * here would let the sheet and `consume` disagree about which recipes are
     * usable for the very same item. Distinct from `recipes` above, which
     * seeds a sheet's rows from a recipe and stays DB-only (an existing,
     * separate gap this does not touch).
     */
    private resolveRecipe?: (recipeUlid: string) => Promise<RecipeRecord | null>
  ) {}

  /**
   * Publishing creates NOTHING in the ledger. A definition is a form awaiting a
   * real event; inventory moves only when the submission lands (§ Cook mode).
   * Same rule that forbids logging a meal at plan time.
   */
  async publish(input: PrepPublishInput): Promise<PrepPublishResult> {
    const components: { label: string; quantity: number; per_basis: Record<string, number>; note?: string }[] = [];
    const consumes: { component: string; item_ulid: string; model: 'divisible' | 'counted' }[] = [];

    // Recipe lines first, so an explicit --component reads as "and also today".
    if (input.recipe_ulid) {
      if (!this.recipes) {
        throw new PrepValidationError('recipe seeding is unavailable: no recipe store is configured');
      }
      const recipe = await this.recipes.get(input.recipe_ulid);
      if (!recipe) throw new PrepValidationError(`recipe not found: ${input.recipe_ulid}`);
      if (!recipe.components?.length) {
        throw new PrepValidationError(`recipe ${recipe.name} has no components to seed a sheet from`);
      }
      for (const line of recipe.components) {
        // A recipe component states its own per-100g inline, so this needs no
        // catalog lookup — and the SAME null rule applies: an unstated field is
        // omitted so it totals unknown, never zero.
        // Spread to a plain record rather than casting: RecipeComponentMacros
        // has no index signature, so a direct cast is a type error under the
        // package build's stricter settings — and spreading is honest anyway.
        const macros: Record<string, unknown> = { ...line.per_100g };
        const per_basis: Record<string, number> = {};
        for (const { key } of PREP_FIELDS) {
          const value = macros[key];
          if (typeof value === 'number' && Number.isFinite(value)) per_basis[key] = value;
        }
        components.push({ label: line.label, quantity: line.default_qty_g, per_basis });
      }
    }

    if (!input.recipe_ulid && !input.components?.length) {
      throw new PrepValidationError('a prep worksheet needs at least one component (or --recipe to seed them)');
    }

    for (const ref of input.components ?? []) {
      if ((ref.product_ulid === undefined) === (ref.item_ulid === undefined)) {
        throw new PrepValidationError('each component needs exactly one of product_ulid or item_ulid');
      }
      if (!Number.isFinite(ref.quantity) || ref.quantity < 0) {
        throw new PrepValidationError(`component quantity must be a non-negative number (got ${ref.quantity})`);
      }

      let productUlid = ref.product_ulid;
      // A derived item (the output of a `packed` batch) has no product by
      // construction — its macros live in its recipe provenance instead
      // (§ Authoring a prep worksheet § A derived component resolves through
      // its recipe, not a product, claude-assist#199). Set below in place of
      // `productUlid` when that channel applies.
      let derived: { total: NutritionFields; label: string } | null = null;

      if (ref.item_ulid) {
        const item = await this.store.getItem(ref.item_ulid);
        if (!item) throw new PrepValidationError(`inventory item not found: ${ref.item_ulid}`);

        if (item.product_ulid) {
          productUlid = item.product_ulid;
        } else {
          derived = await this.resolveDerivedComponentPanel(ref, item);
        }
      }

      let label: string;
      const per_basis: Record<string, number> = {};

      if (derived) {
        // The worksheet's basis is fixed at 100 (below) regardless of what a
        // component measures in, and `quantity` here is whole UNITS, so
        // `per_basis` must satisfy `quantity/100 * per_basis == quantity *
        // (one unit's total)` — i.e. `per_basis = total * 100`. No further
        // scaling by a per-unit mass: unlike a product's per-100g panel, the
        // recipe total already IS one whole unit's macros.
        for (const { key } of PREP_FIELDS) {
          const value = derived.total[key];
          if (typeof value === 'number' && Number.isFinite(value)) per_basis[key] = value * 100;
        }
        label = ref.label ?? derived.label;
      } else {
        const product = await this.store.getProduct(productUlid!);
        if (!product) throw new PrepValidationError(`product not found: ${productUlid}`);

        const panel = product.nutrition_per_100g;
        if (!panel) {
          throw new PrepValidationError(
            `product ${product.name} has no nutrition panel — scan or seed it before building a sheet, ` +
              `rather than letting the sheet invent numbers`
          );
        }

        // Read the module's OWN derived per-100g. It is computed from the
        // serving basis at write time (§ Product corrections), so this is a
        // lookup, never a second implementation of the scaling — and a field
        // the panel does not carry is OMITTED, contributing `unknown` to that
        // total rather than 0.
        for (const { key } of PREP_FIELDS) {
          const value = panel[key];
          if (typeof value === 'number' && Number.isFinite(value)) per_basis[key] = value;
        }

        // A counted component is quantified in UNITS, so its per-basis has to
        // be restated per unit. The worksheet computes `quantity / basis *
        // per_basis` with basis 100, so for `quantity` = units the per-basis
        // must be `per100g * unit_edible_g`:
        //
        //   units/100 * (per100g * unitGrams) == units * unitGrams/100 * per100g
        //
        // i.e. NOT divided by 100 again — the basis already does that. One
        // basis for the whole definition, and the human counts eggs instead
        // of weighing them.
        if (ref.counted) {
          const unitGrams = product.unit_edible_g;
          if (typeof unitGrams !== 'number' || !Number.isFinite(unitGrams) || unitGrams <= 0) {
            throw new PrepValidationError(
              `${product.name} is used as a counted component but has no unit_edible_g — ` +
                `state the edible mass of one unit on the product. It is never derived from a ` +
                `net weight over a count: shell-vs-edible and packed-vs-drained make that wrong ` +
                `in either direction`
            );
          }
          for (const key of Object.keys(per_basis)) {
            per_basis[key] = per_basis[key]! * unitGrams;
          }
        }

        label = ref.label ?? product.name;
      }

      components.push({
        label,
        quantity: ref.quantity,
        per_basis,
        ...(ref.note ? { note: ref.note } : {}),
      });

      // Bind the component to its stock so an eaten submission decrements what
      // was actually stated. Only an ITEM is stock — a product is a catalog row.
      if (ref.item_ulid) {
        consumes.push({
          component: label,
          item_ulid: ref.item_ulid,
          model: ref.counted ? 'counted' : 'divisible',
        });
      }
    }

    const worksheet = {
      kind: 'worksheet',
      version: 1,
      ...(input.heading ? { heading: input.heading } : {}),
      ...(input.intro ? { intro: input.intro } : {}),
      basis: 100,
      unit: 'g',
      fields: PREP_FIELDS.map(({ key, label, unit, precision }) => ({
        key,
        label,
        ...(unit ? { unit } : {}),
        precision,
      })),
      components,
      ...(input.steps?.length ? { steps: input.steps } : {}),
      ...(input.submit_label ? { submit_label: input.submit_label } : {}),
      ...(input.cook
        ? {
            cook_mode: {
              disposition: input.cook.disposition,
              label: input.label,
              ...(input.cook.units !== undefined ? { units: input.cook.units } : {}),
              ...(input.cook.shelf_life_class ? { shelf_life_class: input.cook.shelf_life_class } : {}),
              ...(input.cook.recipe_ulid ? { recipe_ulid: input.cook.recipe_ulid } : {}),
              ...(input.cook.sources?.length ? { sources: input.cook.sources } : {}),
              // BOTH dispositions bind their components to stock. An eaten
              // sheet decrements what it names; a packed one's explicit
              // `sources` are frozen at publish and so cannot follow the
              // corrected weights the sheet exists to collect — a binding can
              // (§ A packed batch's sources follow the submitted weights).
              ...(consumes.length ? { consumes } : {}),
              // Whether the component quantities describe ONE unit or the whole
              // batch. Stated, never inferred: `units: 3` means the whole pot on
              // a farro sheet and one jar of three on an oat sheet, and nothing
              // in the quantities tells them apart.
              ...(input.cook.components_per ? { components_per: input.cook.components_per } : {}),
            },
          }
        : {}),
    };

    const published = await this.publisher.publish({
      slug: input.slug,
      title: input.title ?? input.label,
      worksheet,
      ...(input.digest_optin !== undefined ? { digestOptin: input.digest_optin } : {}),
    });

    const { totals, unknown } = plannedTotals(components);

    return {
      slug: published.slug,
      url: published.url,
      created: published.created,
      planned_totals: totals,
      components: components.map(({ label, quantity, per_basis }) => ({ label, quantity, per_basis })),
      unknown_fields: unknown,
    };
  }

  /**
   * Resolve a component naming an item with NO linked product — a derived
   * item (the output of a `packed` batch), which has no product by
   * construction (§ Conversions: "It has no `product_ulid`"). Its macros live
   * instead in its derivation's `recipe_ulid` provenance — the same channel
   * § Consume from inventory § Eligibility reads for its own derived-item
   * channel (specs/modules/kitchen.md § Authoring a prep worksheet § A
   * derived component resolves through its recipe, not a product,
   * claude-assist#199).
   *
   * Only a COUNTED derived item resolves here: the per-unit recipe contract
   * (§ Consume from inventory § Macro inheritance) guarantees a counted
   * item's recipe describes exactly ONE sealed unit — the same basis a
   * counted sheet component needs. A fraction-modeled derived item's recipe
   * describes the WHOLE BATCH instead, with no absolute mass to anchor a
   * per-100g basis, and a sheet has no analog of `consume`'s single
   * all-or-nothing tap — so it stays refused, same as an item with no recipe
   * at all (refuse, never infer).
   */
  private async resolveDerivedComponentPanel(
    ref: PrepComponentRef,
    item: { ulid: string; units_total: number | null; raw_label: string | null }
  ): Promise<{ total: NutritionFields; label: string }> {
    if (!ref.counted) {
      throw new PrepValidationError(
        `inventory item ${item.ulid} has no linked product, so it carries no panel to build a sheet from ` +
          `directly — a derived item resolves its panel through its recipe only when referenced as counted ` +
          `(--component-unit), because only a counted derived item's recipe describes one sealed unit`
      );
    }
    if (item.units_total == null) {
      throw new PrepValidationError(
        `inventory item ${item.ulid} is not a counted item (no units_total set), so its recipe describes the ` +
          `whole batch, not one sealed unit — a prep sheet has no per-basis to derive from it`
      );
    }

    const derivations = await this.store.getDerivationsByDerivedItemUlids([item.ulid]);
    const recipeUlid = derivations.get(item.ulid)?.recipe_ulid;
    if (!recipeUlid) {
      throw new PrepValidationError(
        `inventory item ${item.ulid} has no linked product and no recipe provenance, so it carries no panel ` +
          `to build a sheet from`
      );
    }
    if (!this.resolveRecipe) {
      throw new PrepValidationError('recipe resolution is unavailable: no recipe resolver is configured');
    }
    const recipe = await this.resolveRecipe(recipeUlid);
    if (!recipe || recipe.components.length === 0) {
      throw new PrepValidationError(
        `recipe ${recipeUlid} linked to inventory item ${item.ulid} was not found or has no components`
      );
    }

    // No quantity override: every component contributes its OWN
    // `default_qty_g`, which is exactly what "the recipe describes one
    // sealed unit" means, and the SAME call `consume`'s derived-item channel
    // makes (`resolveDerivedMacros` in services/inventory.ts) — the sheet and
    // `consume` cannot disagree about what one unit of this batch costs.
    const total = computeRecipeMacros(recipe);
    return { total, label: item.raw_label ?? recipe.name };
  }
}

/**
 * Totals at the planned quantities — a preview for the author, NOT the stored
 * numbers. The submission's totals are computed server-side by the pages module
 * from the published definition; these use the same formula so a mismatch would
 * be visible rather than silent.
 *
 * Null semantics match the rest of the toolkit: a field no component carried is
 * `null` (unknown), never `0`.
 */
export function plannedTotals(
  components: { quantity: number; per_basis: Record<string, number> }[]
): { totals: Record<string, number | null>; unknown: string[] } {
  const totals: Record<string, number | null> = {};
  const unknown: string[] = [];
  for (const { key, precision } of PREP_FIELDS) {
    const carriers = components.filter((c) => typeof c.per_basis[key] === 'number');
    if (carriers.length === 0) {
      totals[key] = null;
      unknown.push(key);
      continue;
    }
    const sum = carriers.reduce((acc, c) => acc + (c.quantity / 100) * c.per_basis[key]!, 0);
    totals[key] = Number(sum.toFixed(precision));
  }
  return { totals, unknown };
}
