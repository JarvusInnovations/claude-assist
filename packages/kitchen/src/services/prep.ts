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
import type { NutritionPer100g } from '../inventory-types.js';

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
  /** Planned quantity in grams — a DEFAULT for the sheet, never a claim. */
  quantity: number;
  /** Overrides the product name on the row. */
  label?: string;
  note?: string;
}

export interface PrepPublishInput {
  slug: string;
  label: string;
  title?: string;
  heading?: string;
  intro?: string;
  components: PrepComponentRef[];
  steps?: string[];
  submit_label?: string;
  cook?: {
    disposition: 'eaten' | 'packed';
    units?: number;
    shelf_life_class?: string;
    recipe_ulid?: string;
    sources?: { item_ulid: string; amount?: number }[];
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
    private publisher: PagePublisher
  ) {}

  /**
   * Publishing creates NOTHING in the ledger. A definition is a form awaiting a
   * real event; inventory moves only when the submission lands (§ Cook mode).
   * Same rule that forbids logging a meal at plan time.
   */
  async publish(input: PrepPublishInput): Promise<PrepPublishResult> {
    if (!input.components?.length) {
      throw new PrepValidationError('a prep worksheet needs at least one component');
    }

    const components: { label: string; quantity: number; per_basis: Record<string, number>; note?: string }[] = [];

    for (const ref of input.components) {
      if ((ref.product_ulid === undefined) === (ref.item_ulid === undefined)) {
        throw new PrepValidationError('each component needs exactly one of product_ulid or item_ulid');
      }
      if (!Number.isFinite(ref.quantity) || ref.quantity < 0) {
        throw new PrepValidationError(`component quantity must be a non-negative number (got ${ref.quantity})`);
      }

      let productUlid = ref.product_ulid;
      if (ref.item_ulid) {
        const item = await this.store.getItem(ref.item_ulid);
        if (!item) throw new PrepValidationError(`inventory item not found: ${ref.item_ulid}`);
        if (!item.product_ulid) {
          throw new PrepValidationError(
            `inventory item ${ref.item_ulid} has no linked product, so it carries no panel to build a sheet from`
          );
        }
        productUlid = item.product_ulid;
      }

      const product = await this.store.getProduct(productUlid!);
      if (!product) throw new PrepValidationError(`product not found: ${productUlid}`);

      const panel = product.nutrition_per_100g;
      if (!panel) {
        throw new PrepValidationError(
          `product ${product.name} has no nutrition panel — scan or seed it before building a sheet, ` +
            `rather than letting the sheet invent numbers`
        );
      }

      // Read the module's OWN derived per-100g. It is computed from the serving
      // basis at write time (§ Product corrections), so this is a lookup, never
      // a second implementation of the scaling — and a field the panel does not
      // carry is OMITTED, contributing `unknown` to that total rather than 0.
      const per_basis: Record<string, number> = {};
      for (const { key } of PREP_FIELDS) {
        const value = panel[key];
        if (typeof value === 'number' && Number.isFinite(value)) per_basis[key] = value;
      }

      components.push({
        label: ref.label ?? product.name,
        quantity: ref.quantity,
        per_basis,
        ...(ref.note ? { note: ref.note } : {}),
      });
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
