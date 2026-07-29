/**
 * Daily targets — owner-set per-nutrient reference lines
 * (specs/modules/kitchen.md § Daily targets).
 *
 * `KITCHEN_DAILY_TARGETS` is opaque instance config, same doctrine as
 * `KITCHEN_TDEE_BASE`: the module stores and serves the lines, never derives,
 * tunes, or interprets them. Parsing is boot-loud — a malformed value throws
 * here (at plugin init) and fails startup, never a warning or a silent drop
 * (a half-parsed budget is worse than none).
 */

/**
 * The panel field names a target may attach to (§ Nutrition panel). Mirrors
 * `NUTRITION_FIELD_KEYS` in types.ts MINUS `sugar_g`: total sugar is captured
 * and displayed but deliberately **untargeted** (§ `added_sugar_g` vs
 * `sugar_g`) — there is no established total-sugar guideline, and a borrowed
 * line fires hardest on a day of fruit, milk, and plain yogurt. The ceiling
 * belongs to `added_sugar_g`, which is here.
 *
 * Deliberately NOT derived from `NUTRITION_FIELD_KEYS` — the divergence is the
 * point, so it is stated once, here, with its reason.
 */
export const DAILY_TARGET_FIELDS = [
  'calories',
  'protein_g',
  'fat_g',
  'sat_fat_g',
  'carbs_g',
  'added_sugar_g',
  'fiber_g',
  'sodium_mg',
] as const;

export type DailyTargetField = (typeof DAILY_TARGET_FIELDS)[number];

/**
 * Panel fields that exist but can never carry a target, with the reason. A
 * config naming one fails boot with that reason rather than the generic
 * unknown-field message — an instance carrying the retired `sugar_g` ceiling
 * needs to be told where the line went, not that the field doesn't exist.
 */
const UNTARGETABLE_FIELDS: Record<string, string> = {
  sugar_g:
    'total sugar carries no target — it is captured and displayed as context only ' +
    '(no established guideline exists for it). Move the ceiling to "added_sugar_g" ' +
    '(e.g. {"added_sugar_g":{"max":36}})',
};

/** Exactly one bound per field: a cap (stay under) or a floor (reach it). */
export type DailyTargetBound = { max: number } | { min: number };

export type DailyTargets = Partial<Record<DailyTargetField, DailyTargetBound>>;

/** Thrown at boot for any malformed KITCHEN_DAILY_TARGETS value. */
export class DailyTargetsConfigError extends Error {
  constructor(message: string) {
    super(`KITCHEN_DAILY_TARGETS: ${message}`);
    this.name = 'DailyTargetsConfigError';
  }
}

/**
 * Parse and validate raw `KITCHEN_DAILY_TARGETS` JSON. Absent/blank input —
 * or an explicit `{}`, zero configured lines — returns undefined: the feature
 * is off and the summary omits `targets` entirely, never defaulted. Anything
 * malformed (invalid JSON, unknown field, both bounds, neither, non-positive
 * N) throws DailyTargetsConfigError.
 */
export function parseDailyTargets(raw: string | undefined): DailyTargets | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DailyTargetsConfigError(`not valid JSON — ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DailyTargetsConfigError('must be a JSON object mapping panel fields to bounds');
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return undefined;

  const targets: DailyTargets = {};
  for (const [field, bound] of entries) {
    if (!(DAILY_TARGET_FIELDS as readonly string[]).includes(field)) {
      const retired = UNTARGETABLE_FIELDS[field];
      if (retired) {
        throw new DailyTargetsConfigError(`"${field}" ${retired}`);
      }
      throw new DailyTargetsConfigError(
        `unknown field "${field}" (targetable fields: ${DAILY_TARGET_FIELDS.join(', ')})`
      );
    }
    if (bound === null || typeof bound !== 'object' || Array.isArray(bound)) {
      throw new DailyTargetsConfigError(`"${field}" must be {"max": N} or {"min": N}`);
    }
    const extraneous = Object.keys(bound).filter((k) => k !== 'max' && k !== 'min');
    if (extraneous.length > 0) {
      throw new DailyTargetsConfigError(
        `"${field}" has unknown bound key(s): ${extraneous.join(', ')}`
      );
    }
    const hasMax = 'max' in bound;
    const hasMin = 'min' in bound;
    if (hasMax === hasMin) {
      // Both or neither — a line points exactly one way (§ Daily targets:
      // direction is semantic, not styling).
      throw new DailyTargetsConfigError(`"${field}" must set exactly one of "max" or "min"`);
    }
    const key = hasMax ? 'max' : 'min';
    const n = (bound as Record<string, unknown>)[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      throw new DailyTargetsConfigError(`"${field}" ${key} must be a positive finite number`);
    }
    targets[field as DailyTargetField] = (hasMax ? { max: n } : { min: n }) as DailyTargetBound;
  }
  return targets;
}
