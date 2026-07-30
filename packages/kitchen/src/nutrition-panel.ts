/**
 * The nutrition panel value type (specs/modules/kitchen.md § Panel operations
 * belong in one implementation).
 *
 * Rebasing, scaling to a weight, summing components into a meal, and
 * validating coherence are one concern, not four helpers scattered across the
 * services that happen to need them. A helper gets bypassed at a call site — a
 * value type that carries its own basis has to be constructed, and the only
 * way to read it as a different basis is through `toPer100g`, which performs
 * the scale explicitly rather than letting a caller reinterpret raw numbers.
 *
 * Domain-agnostic on purpose: the nine field keys live in `NUTRITION_FIELD_KEYS`
 * (types.ts) and this module operates on that shape whether the caller is a
 * product record, a recipe component, or a worksheet reference. Every
 * server-side surface that computes nutrition is meant to route through here.
 */

import { NUTRITION_FIELD_KEYS } from './types.js';
import type { NutritionPer100g } from './inventory-types.js';

export type NutritionFieldKey = (typeof NUTRITION_FIELD_KEYS)[number];

/** A partial nine-field reading — the shape both products and recipes store. */
export type PanelFields = Partial<Record<NutritionFieldKey, number | null>>;

export type PanelBasis = 'per_100g' | 'per_serving';

/**
 * Thrown by `perServingPanel` when asked to construct a per-serving-basis
 * value with no serving size — the basis this module exists to make
 * impossible to lose track of. Never thrown by `per100gPanel`, which has no
 * such precondition.
 */
export class NutritionPanelBasisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NutritionPanelBasisError';
  }
}

/**
 * A panel value tagged with the basis its numbers are stated against. Not a
 * bag of nine numbers: `basis === 'per_serving'` values carry the serving size
 * they are relative to, so `toPer100g` always has what it needs and a caller
 * can never accidentally treat one basis's numbers as the other's.
 */
export interface NutritionPanel {
  readonly basis: PanelBasis;
  /** Non-null exactly when `basis === 'per_serving'`. */
  readonly servingSizeG: number | null;
  readonly fields: PanelFields;
}

/** Construct a per-100g-basis panel. Always constructible — per-100g needs no size. */
export function per100gPanel(fields: PanelFields | null | undefined): NutritionPanel {
  return { basis: 'per_100g', servingSizeG: null, fields: fields ?? {} };
}

/**
 * Construct a per-serving-basis panel. Throws when `servingSizeG` is not a
 * positive finite number — a per-serving reading with no serving size has no
 * basis, so there is nothing a caller could correctly do with it, and
 * returning a value that quietly can't be rebased would just move the bug to
 * whoever calls `toPer100g` later.
 */
export function perServingPanel(fields: PanelFields | null | undefined, servingSizeG: number | null | undefined): NutritionPanel {
  if (typeof servingSizeG !== 'number' || !Number.isFinite(servingSizeG) || servingSizeG <= 0) {
    throw new NutritionPanelBasisError(
      'a per-serving panel requires a positive serving size in grams — without one it has no basis to rebase from'
    );
  }
  return { basis: 'per_serving', servingSizeG, fields: fields ?? {} };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function scaleFields(fields: PanelFields, factor: number): PanelFields {
  const out: PanelFields = {};
  for (const key of NUTRITION_FIELD_KEYS) {
    const v = fields[key];
    out[key] = typeof v === 'number' && Number.isFinite(v) ? round1(v * factor) : null;
  }
  return out;
}

/**
 * Rebase a panel onto per-100g. A `per_100g` panel is returned as-is (no
 * basis change needed); a `per_serving` panel is scaled by `100 /
 * servingSizeG`, per field, in code — never left to the model or the caller
 * (§ Raw serving capture — "capture as printed, scale late").
 */
export function toPer100g(panel: NutritionPanel): PanelFields {
  if (panel.basis === 'per_100g') return panel.fields;
  return scaleFields(panel.fields, 100 / panel.servingSizeG!);
}

/**
 * Scale a panel to an arbitrary gram quantity — e.g. a recipe component's
 * actual logged weight, or an item's consumed share. Always rebases to
 * per-100g first, so a per-serving panel scales correctly regardless of how
 * different its own serving size is from `grams`.
 */
export function scaleToGrams(panel: NutritionPanel, grams: number): PanelFields {
  return scaleFields(toPer100g(panel), grams / 100);
}

/**
 * Deterministic per-100g derivation from a raw per-serving capture
 * (specs/modules/kitchen.md § Raw serving capture, § A panel means nothing
 * without its basis). Returns `null` when there is no usable serving basis —
 * no positive `servingSizeG`, or no per-serving panel at all — which is the
 * caller's signal to fall back to a caller-stated per-100g, when one exists.
 *
 * This is THE derivation — the label-scan pipeline and the panel-basis guard
 * both call this one function, so "derive at every door" and "the label path
 * is unchanged" are the same code path, not two implementations kept in sync
 * by hand.
 */
export function derivePer100gFromServing(servingSizeG: number | null | undefined, perServing: PanelFields | null | undefined): PanelFields | null {
  if (typeof servingSizeG !== 'number' || !Number.isFinite(servingSizeG) || servingSizeG <= 0 || !perServing) {
    return null;
  }
  return toPer100g(perServingPanel(perServing, servingSizeG));
}

/**
 * Sum several already-scaled contributions (each already `scaleToGrams`'d to
 * its actual logged quantity) into one total. A field is `null` in the sum
 * only when NO contribution carried it — an omission is unknown, never zero
 * (§ `added_sugar_g` vs `sugar_g` — "a field is null in the total only when no
 * component carried it"). A contribution that doesn't know a field simply
 * omits that key or states it `null`; either reads as "this component said
 * nothing about it," not "this component contributed zero."
 */
export function sumFields(contributions: readonly PanelFields[]): PanelFields {
  const out: PanelFields = {};
  for (const key of NUTRITION_FIELD_KEYS) {
    let any = false;
    let total = 0;
    for (const c of contributions) {
      const v = c[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        any = true;
        total += v;
      }
    }
    out[key] = any ? round1(total) : null;
  }
  return out;
}

/** One rejected write-time coherence check, named so a 400 can quote it. */
export interface PanelValidationIssue {
  field: NutritionFieldKey | 'calories';
  message: string;
}

/**
 * The calorie-from-macros band is deliberately loose (§ Panel operations
 * belong in one implementation — "the band must stay loose"). Real labels
 * legitimately miss `4·protein + 4·carbs + 9·fat` on sugar-alcohol carbs (~2
 * kcal/g, not 4), fiber accounting, and rounding at small servings, where a
 * tight band would reject sound data and train the check to be disabled — a
 * disabled check is worse than no check because it implies coverage that
 * isn't there. 25% of the computed figure plus a 40 kcal floor tolerates a
 * fully-fiber-and-sugar-alcohol product (worst realistic case, roughly half
 * the stated energy) while still catching a genuinely wrong panel (the
 * corpus this guard was calibrated against had panels wrong by a third or
 * more).
 */
export const CALORIE_BAND_PCT = 0.25;
export const CALORIE_BAND_FLOOR = 40;

const EPSILON = 0.05;

/**
 * Reject-at-write-time coherence checks (§ Panel operations belong in one
 * implementation): no negative fields, saturated fat ≤ fat, added sugar ≤
 * total sugar, calories within the loose band of the macro sum. Returns an
 * empty array when the panel is coherent; only checks a relationship when
 * every field it needs is a stated number (an unknown field is never treated
 * as `0` for the purpose of these checks).
 */
export function validatePanelFields(fields: PanelFields): PanelValidationIssue[] {
  const issues: PanelValidationIssue[] = [];

  for (const key of NUTRITION_FIELD_KEYS) {
    const v = fields[key];
    // A negative value can only be a signed money line that reached the
    // arithmetic (specs/modules/kitchen.md § Billing artifacts are not
    // ingredients) — no food has negative calories or negative sodium.
    if (typeof v === 'number' && v < -EPSILON) {
      issues.push({ field: key, message: `${key} (${v}) must not be negative — no nutrient is ever negative` });
    }
  }

  const fat = fields.fat_g;
  const satFat = fields.sat_fat_g;
  if (typeof fat === 'number' && typeof satFat === 'number' && satFat > fat + EPSILON) {
    issues.push({
      field: 'sat_fat_g',
      message: `sat_fat_g (${satFat}) must not exceed fat_g (${fat}) — saturated fat is a subset of total fat`,
    });
  }

  const sugar = fields.sugar_g;
  const added = fields.added_sugar_g;
  if (typeof sugar === 'number' && typeof added === 'number' && added > sugar + EPSILON) {
    issues.push({
      field: 'added_sugar_g',
      message: `added_sugar_g (${added}) must not exceed sugar_g (${sugar}) — added sugar is a subset of total sugar`,
    });
  }

  const { calories, protein_g, carbs_g } = fields;
  if (typeof calories === 'number' && typeof protein_g === 'number' && typeof carbs_g === 'number' && typeof fat === 'number') {
    const computed = 4 * protein_g + 4 * carbs_g + 9 * fat;
    const tolerance = computed * CALORIE_BAND_PCT + CALORIE_BAND_FLOOR;
    if (Math.abs(calories - computed) > tolerance) {
      issues.push({
        field: 'calories',
        message:
          `calories (${calories}) is too far from 4·protein + 4·carbs + 9·fat (${round1(computed)}) ` +
          `— off by more than the ${CALORIE_BAND_PCT * 100}% + ${CALORIE_BAND_FLOOR} kcal band`,
      });
    }
  }

  return issues;
}

/** Render `validatePanelFields` issues as the message a write-time `400` carries. */
export function panelValidationMessage(name: string, issues: readonly PanelValidationIssue[]): string {
  return `Refusing to store "${name}"'s nutrition panel: ${issues.map((i) => i.message).join('; ')}.`;
}
