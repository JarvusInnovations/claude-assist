/**
 * Kitchen summary for the briefing, read from the kitchen module's tables
 * (claude-assist Postgres) — today's logged totals plus, from phase-2
 * inventory, an eat-first line (most-urgent on-hand items) and stock-aware
 * meal suggestions (recipes whose components are plausibly on hand).
 *
 * Follows the captures-source pattern: a direct read of the sibling module's
 * schema, no import of @jarvus/claude-assist-kitchen. Suggestions prefer the
 * server-injected KitchenRecipesProvider (the kitchen module's merged
 * sheet + pushed + promoted view, so meal-bank sheet recipes participate
 * from day one); without it they fall back to a direct SQL read of
 * DB-persisted recipes only. Every read degrades to omission (its own
 * error/empty) if the kitchen schema or a phase-2 table is absent — the
 * briefing never fails on a missing source.
 */

import type postgres from 'postgres';
import type { KitchenRecipeSummary, KitchenRecipesProvider } from '@jarvus/claude-assist-core';
import { zonedDayWindow } from '../../time.js';

/** One most-urgent on-hand item for the eat-first line. */
export interface EatFirstItem {
  label: string;
  state: string;
  eatBy: string | null;
  daysUntil: number | null;
  fraction: number;
}

/** A meal-bank/recipe suggestion makeable from current stock (conservative). */
export interface MealSuggestion {
  name: string;
  have: number;
  total: number;
}

export interface KitchenSummary {
  calories: number;
  proteinG: number;
  satFatG: number;
  /** Entries logged today that are still awaiting an estimate (excluded from the totals). */
  pendingCount: number;
  /** Most-urgent open/stocked items entering their final days (eat-first). */
  eatFirst: EatFirstItem[];
  /** Recipes plausibly makeable from current stock; empty ⇒ line omitted. */
  suggestions: MealSuggestion[];
  error: string | null;
}

interface RecipeRow {
  name: string;
  components: unknown;
}

export interface KitchenSummaryOptions {
  dateIso: string;
  timeZone: string;
  /** Max eat-first items to surface (default 5). */
  eatFirstLimit?: number;
  /** Max meal suggestions to surface (default 3). */
  suggestionLimit?: number;
  /**
   * Kitchen module's merged recipe view (sheet + pushed + promoted), injected
   * by the server. Preferred over the SQL fallback so sheet recipes qualify.
   */
  recipesProvider?: KitchenRecipesProvider;
}

export async function fetchKitchenSummary(
  sql: postgres.Sql,
  opts: KitchenSummaryOptions
): Promise<KitchenSummary> {
  const empty: KitchenSummary = {
    calories: 0,
    proteinG: 0,
    satFatG: 0,
    pendingCount: 0,
    eatFirst: [],
    suggestions: [],
    error: null,
  };

  try {
    const { fromIso, toIso } = zonedDayWindow(opts.dateIso, opts.timeZone);

    // Daily totals are EFFECTIVE macros: base * portion_multiplier per entry
    // (specs/modules/kitchen.md § Portion multiplier). portion_multiplier is
    // NOT NULL DEFAULT 1, so unscaled rows contribute their base unchanged.
    const [totals] = await sql<{ calories: string | null; protein_g: string | null; sat_fat_g: string | null }[]>`
      SELECT
        COALESCE(SUM(calories * portion_multiplier), 0) AS calories,
        COALESCE(SUM(protein_g * portion_multiplier), 0) AS protein_g,
        COALESCE(SUM(sat_fat_g * portion_multiplier), 0) AS sat_fat_g
      FROM kitchen.entries
      WHERE status = 'estimated' AND logged_at >= ${fromIso} AND logged_at < ${toIso}
    `;

    const [pending] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM kitchen.entries
      WHERE status = 'estimating' AND logged_at >= ${fromIso} AND logged_at < ${toIso}
    `;

    const eatFirst = await fetchEatFirst(sql, opts.eatFirstLimit ?? 5);
    const suggestions = await fetchSuggestions(sql, opts.suggestionLimit ?? 3, opts.recipesProvider);

    return {
      calories: Math.round(parseFloat(totals?.calories ?? '0')),
      proteinG: Math.round(parseFloat(totals?.protein_g ?? '0')),
      satFatG: Math.round(parseFloat(totals?.sat_fat_g ?? '0') * 10) / 10,
      pendingCount: pending?.count ?? 0,
      eatFirst,
      suggestions,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...empty, error: `kitchen summary unavailable: ${message}` };
  }
}

/** Most-urgent on-hand items with a known eat-by. Phase-2 table absent ⇒ []. */
async function fetchEatFirst(sql: postgres.Sql, limit: number): Promise<EatFirstItem[]> {
  try {
    const rows = await sql<
      { label: string | null; state: string; eat_by: string | null; days_until: number | null; fraction: string | null }[]
    >`
      SELECT
        COALESCE(p.name, i.raw_label) AS label,
        i.state::text AS state,
        to_char(i.eat_by, 'YYYY-MM-DD') AS eat_by,
        (i.eat_by - CURRENT_DATE) AS days_until,
        i.on_hand_fraction AS fraction
      FROM kitchen.inventory_items i
      LEFT JOIN kitchen.products p ON p.ulid = i.product_ulid
      WHERE i.state IN ('stocked', 'open') AND i.eat_by IS NOT NULL AND i.on_hand_fraction > 0
      ORDER BY i.eat_by ASC, i.acquired_at ASC
      LIMIT ${Math.max(1, limit)}
    `;
    return rows.map((r) => ({
      label: r.label ?? 'unlabeled item',
      state: r.state,
      eatBy: r.eat_by,
      daysUntil: r.days_until == null ? null : Number(r.days_until),
      fraction: r.fraction == null ? 0 : parseFloat(r.fraction),
    }));
  } catch {
    return [];
  }
}

/**
 * Recipes plausibly makeable from current stock. The recipe list comes from
 * the injected provider (the kitchen module's merged sheet + pushed + promoted
 * view) when available, else the SQL fallback over DB-persisted recipes.
 * Exported for tests.
 */
export async function fetchSuggestions(
  sql: postgres.Sql,
  limit: number,
  recipesProvider?: KitchenRecipesProvider
): Promise<MealSuggestion[]> {
  try {
    const onHand = await sql<{ name: string | null; aliases: string[] | null; raw_label: string | null }[]>`
      SELECT p.name AS name, p.aliases AS aliases, i.raw_label AS raw_label
      FROM kitchen.inventory_items i
      LEFT JOIN kitchen.products p ON p.ulid = i.product_ulid
      WHERE i.state IN ('stocked', 'open') AND i.on_hand_fraction > 0
    `;
    if (onHand.length === 0) return [];

    const stock: string[] = [];
    for (const r of onHand) {
      if (r.name) stock.push(r.name.toLowerCase());
      for (const a of r.aliases ?? []) stock.push(a.toLowerCase());
      if (r.raw_label) stock.push(r.raw_label.toLowerCase());
    }

    const recipes = await readRecipeSummaries(sql, recipesProvider);
    return scoreSuggestions(stock, recipes, limit);
  } catch {
    return [];
  }
}

/** Provider-first recipe read; SQL fallback covers DB rows only (no sheet). */
async function readRecipeSummaries(
  sql: postgres.Sql,
  recipesProvider?: KitchenRecipesProvider
): Promise<KitchenRecipeSummary[]> {
  if (recipesProvider) {
    return recipesProvider();
  }
  const rows = await sql<RecipeRow[]>`SELECT name, components FROM kitchen.recipes`;
  return rows.map((r) => ({ name: r.name, component_labels: componentLabels(r.components) }));
}

/**
 * Conservative scoring: a recipe qualifies only when a majority (≥60%) of its
 * named components match an on-hand item's product name/alias/raw label, and
 * at least one matches. Ranked by how much stock it'd use (matched count),
 * then most-complete first. Pure — exported for tests.
 */
export function scoreSuggestions(
  stock: string[],
  recipes: KitchenRecipeSummary[],
  limit: number
): MealSuggestion[] {
  const scored: MealSuggestion[] = [];
  for (const recipe of recipes) {
    const labels = recipe.component_labels.map((l) => l.toLowerCase());
    if (labels.length === 0) continue;
    const have = labels.filter((label) => stock.some((s) => tokenMatch(label, s))).length;
    if (have >= 1 && have / labels.length >= 0.6) {
      scored.push({ name: recipe.name, have, total: labels.length });
    }
  }
  return scored
    .sort((a, b) => b.have - a.have || b.have / b.total - a.have / a.total)
    .slice(0, Math.max(1, limit));
}

function componentLabels(components: unknown): string[] {
  const parsed = typeof components === 'string' ? safeJson(components) : components;
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const c of parsed) {
    if (c && typeof c === 'object' && typeof (c as Record<string, unknown>).label === 'string') {
      out.push(((c as Record<string, unknown>).label as string).toLowerCase());
    }
  }
  return out;
}

/** Conservative token match: either string contains the other (both non-trivial). */
function tokenMatch(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (x.length < 3 || y.length < 3) return x === y;
  return x.includes(y) || y.includes(x);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
