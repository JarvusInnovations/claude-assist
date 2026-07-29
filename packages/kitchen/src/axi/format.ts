import { custom, type FieldDef } from "./toon.js";
import { NUTRITION_FIELD_KEYS } from "../types.js";

/**
 * Effective-macro helpers. The wire carries BASE macros plus a
 * `portion_multiplier`; every consumer computes `effective = base × multiplier`
 * itself (specs/modules/kitchen.md § Portion multiplier). These helpers keep
 * that one rule in one place for the CLI's rollups and tiles.
 */

/** The canonical panel list (§ Nutrition panel), never a second copy of it. */
const MACRO_KEYS = NUTRITION_FIELD_KEYS;
export type MacroKey = (typeof MACRO_KEYS)[number];

export type MacroTotals = Record<MacroKey, number>;

/** Effective value of one base macro field on an entry (base × multiplier). */
export function effectiveMacro(entry: Record<string, any>, key: MacroKey): number | null {
  const base = entry[key];
  if (base === null || base === undefined) return null;
  const mult = typeof entry.portion_multiplier === "number" ? entry.portion_multiplier : 1;
  return round(base * mult);
}

/** Sum effective macros across a set of entries (nulls skipped, not zeroed). */
export function sumEffective(entries: Record<string, any>[]): MacroTotals {
  const totals = Object.fromEntries(MACRO_KEYS.map((k) => [k, 0])) as MacroTotals;
  for (const e of entries) {
    const mult = typeof e.portion_multiplier === "number" ? e.portion_multiplier : 1;
    for (const key of MACRO_KEYS) {
      const base = e[key];
      if (typeof base === "number") totals[key] += base * mult;
    }
  }
  for (const key of MACRO_KEYS) totals[key] = round(totals[key]);
  return totals;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** One owner-set daily reference line, as served verbatim on the summary. */
export type TargetBound = { max: number } | { min: number };

/**
 * Render one configured daily-target line as `logged / target` with a
 * direction-aware remaining (specs/modules/kitchen.md § Daily targets).
 * remaining = target − logged is display arithmetic computed HERE, client-
 * side — the server serves the two numbers, never the judgment, and nothing
 * about the figure is ever derived from the day's burn (framing rule).
 */
export function targetLine(logged: number, bound: TargetBound): string {
  if ("max" in bound) {
    const left = round(bound.max - logged);
    return left >= 0
      ? `${logged} / ${bound.max} max (${left} left)`
      : `${logged} / ${bound.max} max (${round(-left)} over)`;
  }
  const toGo = round(bound.min - logged);
  return toGo > 0 ? `${logged} / ${bound.min} min (${toGo} to go)` : `${logged} / ${bound.min} min (met)`;
}

/**
 * The sugar pair as ONE nested figure, never two independent lines
 * (specs/modules/kitchen.md § Display: one nested bar, not two). Total sugar is
 * the extent; added sugar is the segment inside it; the only threshold — and so
 * the only over/under verdict — belongs to the added portion. Rendering them as
 * two peer target lines is what reintroduces the false alarm this split exists
 * to retire, so the two numbers travel in one string here.
 *
 * `total`/`added` are the day's EFFECTIVE totals, each `null` when no entry that
 * day carried the field. A null added portion renders "added unknown" — never
 * `0`, which would fabricate a clean day out of missing data.
 */
export function nestedSugarLine(
  total: number | null,
  added: number | null,
  addedBound?: TargetBound
): string {
  const extent = total === null ? "unknown" : `${round(total)}`;
  const inner =
    added === null
      ? "added unknown"
      : addedBound
        ? `added ${targetLine(round(added), addedBound)}`
        : `added ${round(added)}`;
  return `${extent} total, ${inner}`;
}

/**
 * TOON columns for an entry row: identity + status + effective headline macros.
 * `day` is the server-computed owner-tz calendar date (§ Timezone & local-day
 * bucketing) — the authoritative bucketing key; an agent groups/filters by it
 * and NEVER parses a timestamp to derive a day.
 */
export const ENTRY_ROW_SCHEMA: FieldDef[] = [
  { type: "field", key: "ulid" },
  { type: "field", key: "day" },
  { type: "field", key: "label" },
  { type: "field", key: "status" },
  { type: "field", key: "source" },
  { type: "field", key: "portion_multiplier", as: "mult" },
  custom("kcal", (e) => effectiveMacro(e, "calories")),
  custom("protein", (e) => effectiveMacro(e, "protein_g")),
];
