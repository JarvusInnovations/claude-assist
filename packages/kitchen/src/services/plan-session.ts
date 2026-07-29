/**
 * Meal-planning context builder + preload-prompt composer for
 * `POST /api/kitchen/plan-session` (specs/modules/kitchen.md § Plan-session).
 *
 * Gathers the current kitchen state from the module's own stores — today's
 * EFFECTIVE totals, eat-first inventory, recent meals, meal-bank/reselect
 * options, open needs-info items — and composes a concise warm-start briefing
 * for a session the human takes over. The briefing is a warm-start, not a data
 * dump: the session's working directory (instance config) already carries the
 * kitchen CLI + diet protocol to pull more.
 *
 * Effective totals follow the one wire rule (§ Portion multiplier):
 * `effective = base × portion_multiplier`, summed over today's `estimated`
 * entries — the same computation the briefing daily-totals source uses.
 */

import type { KitchenPipeline } from './pipeline.js';
import type { InventoryPipeline } from './inventory.js';
import { NUTRITION_FIELD_KEYS } from '../types.js';
import type { EntryRecord } from '../types.js';
import type { InventoryState } from '../inventory-types.js';

/** The canonical panel list (§ Nutrition panel), never a second copy of it. */
const MACRO_KEYS = NUTRITION_FIELD_KEYS;
type MacroKey = (typeof MACRO_KEYS)[number];
export type MacroTotals = Record<MacroKey, number>;

const ON_HAND_STATES: InventoryState[] = ['stocked', 'open'];

export interface EatFirstLine {
  label: string;
  state: string;
  eatBy: string | null;
  daysUntil: number | null;
  onHandFraction: number;
}

export interface RecentLine {
  label: string;
  calories: number | null;
  proteinG: number | null;
  logCount: number;
}

export interface MealBankLine {
  name: string;
  componentLabels: string[];
}

export interface PlanningContext {
  /** Server-local `YYYY-MM-DD`. */
  date: string;
  /** Effective macro totals over today's estimated entries. */
  totals: MacroTotals;
  /** Entries logged today (any status). */
  todayCount: number;
  /** Today's entries still awaiting an estimate (excluded from totals). */
  pendingCount: number;
  eatFirst: EatFirstLine[];
  recent: RecentLine[];
  mealBank: MealBankLine[];
  openQuestions: { count: number; examples: string[] };
}

export interface PlanningContextConfig {
  /** Max eat-first items (default 8). */
  eatFirstLimit?: number;
  /** Max recent meals (default 8). */
  recentLimit?: number;
  /** Max meal-bank options (default 8). */
  mealBankLimit?: number;
  /** Max needs-info examples (default 5). */
  questionLimit?: number;
}

function startOfTodayIso(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Sum effective macros (base × portion_multiplier) over estimated entries. */
export function sumEffectiveTotals(entries: EntryRecord[]): MacroTotals {
  const totals: MacroTotals = {
    calories: 0,
    protein_g: 0,
    fat_g: 0,
    sat_fat_g: 0,
    carbs_g: 0,
    sugar_g: 0,
    added_sugar_g: 0,
    fiber_g: 0,
    sodium_mg: 0,
  };
  for (const e of entries) {
    if (e.status !== 'estimated') continue;
    const mult = typeof e.portion_multiplier === 'number' ? e.portion_multiplier : 1;
    for (const key of MACRO_KEYS) {
      const base = (e as unknown as Record<string, unknown>)[key];
      if (typeof base === 'number') totals[key] += base * mult;
    }
  }
  for (const key of MACRO_KEYS) totals[key] = round(totals[key]);
  return totals;
}

export interface PlanSessionDeps {
  pipeline: KitchenPipeline;
  inventory: InventoryPipeline;
}

/** Gather the meal-planning context from the kitchen module's own stores. */
export async function gatherPlanningContext(
  deps: PlanSessionDeps,
  config: PlanningContextConfig = {},
  now: Date = new Date(),
): Promise<PlanningContext> {
  const { pipeline, inventory } = deps;
  const eatFirstLimit = config.eatFirstLimit ?? 8;
  const recentLimit = config.recentLimit ?? 8;
  const mealBankLimit = config.mealBankLimit ?? 8;
  const questionLimit = config.questionLimit ?? 5;

  const since = new Date(startOfTodayIso(now));

  const [todayEntries, items, strip, questions] = await Promise.all([
    pipeline.list({ since }),
    inventory.listInventory({ states: ON_HAND_STATES, limit: eatFirstLimit * 3 }),
    pipeline.reselect(Math.max(recentLimit, mealBankLimit)),
    inventory.listQuestions(questionLimit),
  ]);

  const totals = sumEffectiveTotals(todayEntries);
  const pendingCount = todayEntries.filter((e) => e.status === 'estimating').length;

  // Eat-first: on-hand items with stock remaining, already eat_by-ascending
  // from the store; keep only those actually on hand and cap.
  const eatFirst: EatFirstLine[] = items
    .filter((i) => i.on_hand_fraction > 0)
    .slice(0, eatFirstLimit)
    .map((i) => ({
      label: i.product_name ?? i.raw_label ?? 'unlabeled item',
      state: i.state,
      eatBy: i.eat_by,
      daysUntil: i.days_until_eat_by,
      onHandFraction: i.on_hand_fraction,
    }));

  const recent: RecentLine[] = strip.recent.slice(0, recentLimit).map((r) => ({
    label: r.label,
    calories: r.calories,
    proteinG: r.protein_g,
    logCount: r.log_count,
  }));

  const mealBank: MealBankLine[] = strip.recipes.slice(0, mealBankLimit).map((r) => ({
    name: r.name,
    componentLabels: r.components.map((c) => c.label),
  }));

  const openQuestions = {
    count: questions.length,
    examples: questions.map((q) => q.raw_label ?? 'unlabeled item').slice(0, questionLimit),
  };

  return { date: since.toISOString().slice(0, 10), totals, todayCount: todayEntries.length, pendingCount, eatFirst, recent, mealBank, openQuestions };
}

/** The session title handed to the spawner. */
export const PLAN_SESSION_TITLE = 'meal-planning';

/**
 * The caller group tag handed to the spawner (`SpawnRequest.group`), so the
 * configured spawn command can route/organize kitchen-spawned sessions
 * separately from other callers. See specs/modules/session-spawn.md.
 */
export const PLAN_SESSION_GROUP = 'kitchen';

/**
 * Compose the warm-start preload prompt from the gathered context. Pure and
 * exported for tests. Names only the owner's own kitchen state — no instance
 * data beyond what the owner already logged.
 */
export function composePreloadPrompt(ctx: PlanningContext): string {
  const lines: string[] = [];

  lines.push('You are opening a warm meal-planning session. Below is the current kitchen state as of ' + ctx.date + '.');
  lines.push('');

  const t = ctx.totals;
  lines.push(
    `Today so far (${ctx.todayCount} entr${ctx.todayCount === 1 ? 'y' : 'ies'} logged` +
      (ctx.pendingCount ? `, ${ctx.pendingCount} still estimating` : '') +
      '): ' +
      `${t.calories} kcal, ${t.protein_g} g protein, ${t.fat_g} g fat (${t.sat_fat_g} g sat), ` +
      `${t.carbs_g} g carbs, ${t.sugar_g} g sugar (${t.added_sugar_g} g added), ` +
      `${t.fiber_g} g fiber, ` +
      `${t.sodium_mg} mg sodium (effective totals).`,
  );
  lines.push('');

  if (ctx.eatFirst.length) {
    lines.push('Eat-first (most urgent on hand, oldest eat-by first):');
    for (const i of ctx.eatFirst) {
      const when = i.eatBy
        ? ` — eat by ${i.eatBy}${i.daysUntil != null ? ` (${i.daysUntil}d)` : ''}`
        : '';
      const frac = i.onHandFraction < 1 ? ` (~${Math.round(i.onHandFraction * 100)}% left)` : '';
      lines.push(`- ${i.label} [${i.state}]${when}${frac}`);
    }
    lines.push('');
  }

  if (ctx.recent.length) {
    lines.push('Recently/frequently logged meals:');
    for (const r of ctx.recent) {
      const macros = r.calories != null ? ` (~${r.calories} kcal${r.proteinG != null ? `, ${r.proteinG} g protein` : ''})` : '';
      lines.push(`- ${r.label}${macros} ×${r.logCount}`);
    }
    lines.push('');
  }

  if (ctx.mealBank.length) {
    lines.push('Meal-bank / reselect options:');
    for (const m of ctx.mealBank) {
      const comps = m.componentLabels.length ? ` — ${m.componentLabels.join(', ')}` : '';
      lines.push(`- ${m.name}${comps}`);
    }
    lines.push('');
  }

  if (ctx.openQuestions.count) {
    lines.push(
      `Open needs-info items: ${ctx.openQuestions.count}` +
        (ctx.openQuestions.examples.length ? ` (e.g. ${ctx.openQuestions.examples.join('; ')})` : '') +
        '. Worth resolving while planning.',
    );
    lines.push('');
  }

  lines.push(
    'When the human takes over, help them plan meals that use what is aging first and hit their targets. ' +
      'Use the kitchen CLI and diet protocol available in this session to pull anything more you need.',
  );

  return lines.join('\n');
}
