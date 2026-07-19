import { custom, type FieldDef } from "./toon.js";

/**
 * Effective-macro helpers. The wire carries BASE macros plus a
 * `portion_multiplier`; every consumer computes `effective = base × multiplier`
 * itself (specs/modules/kitchen.md § Portion multiplier). These helpers keep
 * that one rule in one place for the CLI's rollups and tiles.
 */

const MACRO_KEYS = ["calories", "protein_g", "fat_g", "sat_fat_g", "carbs_g", "sodium_mg"] as const;
export type MacroKey = (typeof MACRO_KEYS)[number];

export interface MacroTotals {
  calories: number;
  protein_g: number;
  fat_g: number;
  sat_fat_g: number;
  carbs_g: number;
  sodium_mg: number;
}

/** Effective value of one base macro field on an entry (base × multiplier). */
export function effectiveMacro(entry: Record<string, any>, key: MacroKey): number | null {
  const base = entry[key];
  if (base === null || base === undefined) return null;
  const mult = typeof entry.portion_multiplier === "number" ? entry.portion_multiplier : 1;
  return round(base * mult);
}

/** Sum effective macros across a set of entries (nulls skipped, not zeroed). */
export function sumEffective(entries: Record<string, any>[]): MacroTotals {
  const totals: MacroTotals = { calories: 0, protein_g: 0, fat_g: 0, sat_fat_g: 0, carbs_g: 0, sodium_mg: 0 };
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

/** TOON columns for an entry row: identity + status + effective headline macros. */
export const ENTRY_ROW_SCHEMA: FieldDef[] = [
  { type: "field", key: "ulid" },
  { type: "dateOnly", key: "logged_at", as: "logged" },
  { type: "field", key: "label" },
  { type: "field", key: "status" },
  { type: "field", key: "source" },
  { type: "field", key: "portion_multiplier", as: "mult" },
  custom("kcal", (e) => effectiveMacro(e, "calories")),
  custom("protein", (e) => effectiveMacro(e, "protein_g")),
];
