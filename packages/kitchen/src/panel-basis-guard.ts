/**
 * The panel-basis guard (specs/modules/kitchen.md § Nutrition panel §
 * A panel means nothing without its basis).
 *
 * A product can hold the same nutrition twice — `serving_size_g` +
 * `nutrition_per_serving`, and `nutrition_per_100g`. `derivePer100gFromServing`
 * (nutrition-panel.ts) already derives the second from the first wherever a
 * serving basis exists, on the reasoning that serving arithmetic is the
 * classic extraction error ("capture as printed, scale late"). Before this
 * guard existed, that derivation ran at exactly one call site — the
 * label-scan pipeline — and every other product write door (`POST
 * /products`'s three branches, `PATCH /products/:ulid`, and therefore the
 * agent-facing CLI on top of them) took a caller-stated `nutrition_per_100g`
 * verbatim with nothing checking it against a `nutrition_per_serving` sitting
 * in the same row. In a production ledger, 2 of 18 products carrying both
 * representations had silently disagreed — `calories` wrong in both, one
 * under-reporting its own energy by a third.
 *
 * This module makes the derivation run at every door, following
 * `negligible-guard.ts`'s shape exactly: a pure function handed the record
 * about to be written (the post-merge composite each door already builds for
 * the negligible guard), not the half the request happened to state, so a
 * two-step create-then-patch can't slip an underived panel past a guard that
 * only ever saw one request.
 */

import type { NutritionPer100g } from './inventory-types.js';
import { derivePer100gFromServing, type NutritionFieldKey } from './nutrition-panel.js';
import { NUTRITION_FIELD_KEYS } from './types.js';

/**
 * The 8%-of-derived-value tolerance, applied per field. Percentage alone
 * misfires at small magnitudes — 0.5 g of saturated fat is a 100% relative
 * error against a derived 0.4 g and means nothing, since labels round to the
 * nearest half-gram or whole milligram at that scale. See
 * `PANEL_BASIS_TOLERANCE_FLOOR` for the absolute floor that fixes this.
 */
export const PANEL_BASIS_TOLERANCE_PCT = 0.08;

/**
 * The absolute floor added to the percentage tolerance, in the field's own
 * unit (g, mg, or kcal). Load-bearing at small magnitudes — see
 * `PANEL_BASIS_TOLERANCE_PCT`. Calibrated against a real 18-product corpus
 * carrying both representations: this combined tolerance flags exactly the
 * two rows that had silently disagreed and none of the sixteen sound ones
 * (see `sweepPanelBasisInconsistencies`'s test fixture).
 */
export const PANEL_BASIS_TOLERANCE_FLOOR = 0.6;

/** The product facts the guard needs. Deliberately structural, like `NegligibleCandidate`. */
export interface PanelBasisCandidate {
  nutrition_per_100g?: Partial<NutritionPer100g> | null;
  nutrition_per_serving?: Partial<NutritionPer100g> | null;
  serving_size_g?: number | null;
}

/** One field where a caller-stated per-100g disagreed with the derivable value beyond tolerance. */
export interface PanelBasisContradiction {
  field: NutritionFieldKey;
  stated: number;
  derived: number;
  tolerance: number;
}

export interface PanelBasisResolution {
  /**
   * The per-100g panel that should be WRITTEN. Meaningless when
   * `contradictions` is non-empty — the caller must refuse the write instead
   * of using this value.
   */
  nutrition_per_100g: Partial<NutritionPer100g> | null;
  /** Non-empty means: refuse the write. Empty means `nutrition_per_100g` above is safe to store. */
  contradictions: PanelBasisContradiction[];
}

/**
 * Resolve what `nutrition_per_100g` a write should actually store, given the
 * composite record it is about to produce.
 *
 * - No serving basis derivable (no `serving_size_g`, or no per-serving panel)
 *   → the caller-stated per-100g is honoured **as given** — the genuine
 *   per-100g case: labels printed that way, or reference-sourced foods (loose
 *   produce) with no label at all to state a serving from.
 * - A serving basis IS derivable → per field, the derived value wins; a
 *   caller-stated value for a field the derivation couldn't reach (the
 *   per-serving panel didn't carry that field) still fills the gap, so a
 *   write is never worse than not running this guard. A caller-stated field
 *   that DISAGREES with a derivable one beyond tolerance is a contradiction,
 *   reported rather than silently overwritten — a caller who believes it has
 *   better numbers finds out rather than winning by writing last.
 */
export function resolvePanelBasis(candidate: PanelBasisCandidate): PanelBasisResolution {
  const stated = candidate.nutrition_per_100g ?? null;
  const derived = derivePer100gFromServing(candidate.serving_size_g ?? null, candidate.nutrition_per_serving ?? null);

  if (!derived) {
    return { nutrition_per_100g: stated, contradictions: [] };
  }

  const contradictions: PanelBasisContradiction[] = [];
  const resolved = {} as Partial<NutritionPer100g>;
  for (const key of NUTRITION_FIELD_KEYS as readonly NutritionFieldKey[]) {
    const d = derived[key];
    const s = stated?.[key];
    if (typeof d === 'number' && typeof s === 'number') {
      const tolerance = Math.abs(d) * PANEL_BASIS_TOLERANCE_PCT + PANEL_BASIS_TOLERANCE_FLOOR;
      if (Math.abs(s - d) > tolerance) {
        contradictions.push({ field: key, stated: s, derived: d, tolerance: Math.round(tolerance * 100) / 100 });
      }
    }
    resolved[key] = typeof d === 'number' ? d : typeof s === 'number' ? s : null;
  }

  if (contradictions.length > 0) {
    return { nutrition_per_100g: null, contradictions };
  }
  return { nutrition_per_100g: resolved, contradictions: [] };
}

/**
 * The refusal rendered as the message a `400` carries. Names every
 * contradicting field with both values, so the caller can tell at a glance
 * whether its serving basis or its per-100g is the one that's wrong.
 */
export function panelBasisRefusalMessage(name: string, contradictions: readonly PanelBasisContradiction[]): string {
  const detail = contradictions
    .map((c) => `${c.field}: stated ${c.stated} vs ${c.derived} derived from the serving basis (tolerance ±${c.tolerance})`)
    .join('; ');
  return (
    `Refusing to store "${name}"'s stated nutrition_per_100g — it contradicts the value derivable from ` +
    `nutrition_per_serving ÷ serving_size_g × 100 (${detail}). Per-100g is derived, not stated, wherever a serving ` +
    'basis exists (specs/modules/kitchen.md § A panel means nothing without its basis). Either the serving basis or ' +
    'the stated per-100g is wrong — correct whichever one is, or drop the stated per-100g and let it derive.'
  );
}

/** One product's stored panel, found to disagree with its own derivable value. */
export interface PanelBasisSweepFinding {
  ulid: string;
  name: string;
  contradictions: PanelBasisContradiction[];
}

/** The read-only shape the sweep needs from a stored product row. */
export interface PanelBasisSweepCandidate extends PanelBasisCandidate {
  ulid: string;
  name: string;
}

/**
 * The legacy sweep: a read-side consistency report over ALREADY-STORED
 * products, for rows written before this guard existed (or through a door
 * this guard doesn't cover). Reports only — never rewrites a stored value,
 * for the same reason the negligible guard's pre-existing mismarks are left
 * alone: an automatic rewrite would pick a winner between two numbers without
 * knowing which one is real. Reuses `resolvePanelBasis` so the sweep and the
 * write-time guard can never disagree about what counts as a contradiction.
 */
export function sweepPanelBasisInconsistencies(products: readonly PanelBasisSweepCandidate[]): PanelBasisSweepFinding[] {
  const findings: PanelBasisSweepFinding[] = [];
  for (const product of products) {
    const { contradictions } = resolvePanelBasis(product);
    if (contradictions.length > 0) {
      findings.push({ ulid: product.ulid, name: product.name, contradictions });
    }
  }
  return findings;
}
