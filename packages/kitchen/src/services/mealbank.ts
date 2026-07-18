/**
 * Meal-bank gitsheet read-through: the module's `sheet`-sourced recipes are
 * a projection of an instance-configured gitsheet, never written here
 * (specs/modules/kitchen.md § Meal-bank sheet consumption). Both
 * KITCHEN_MEALBANK_REPO_PATH and KITCHEN_MEALBANK_SHEET are optional —
 * unset degrades to recents-only reselect, no error.
 *
 * TODO(specs/modules/kitchen.md § Meal-bank sheet consumption): open with
 * `contract: { schema: MEAL_RECORD_CONTRACT, mode: 'verify' }` once the
 * gitsheets consumer-verify surface ships (rung-1 declared identity
 * preferred, structural fallback). Until then this reads plain — a
 * malformed sheet degrades a record to "skipped", never crashes the read.
 */

import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { RecipeComponent, RecipeRecord } from '../types.js';
import { ulidFromSeed } from '../ulid.js';

export interface MealBankConfig {
  /** Absolute path to the instance's own repo clone (KITCHEN_MEALBANK_REPO_PATH). */
  repoPath?: string;
  /** Sheet name declared under that repo's .gitsheets/ (KITCHEN_MEALBANK_SHEET). */
  sheetName?: string;
}

/** Raw shape expected of a meal-bank sheet record — see contracts/meal-record.v1.schema.json. */
interface MealBankRawRecord {
  name?: unknown;
  components?: unknown;
  calories?: unknown;
  protein_g?: unknown;
  sat_fat_g?: unknown;
}

function toComponents(raw: unknown): RecipeComponent[] {
  if (!Array.isArray(raw)) return [];
  const out: RecipeComponent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const label = typeof c.label === 'string' ? c.label : null;
    const defaultQty = typeof c.default_qty_g === 'number' ? c.default_qty_g : null;
    const per100g = c.per_100g && typeof c.per_100g === 'object' ? (c.per_100g as Record<string, unknown>) : null;
    if (!label || defaultQty === null || !per100g) continue;
    const calories = typeof per100g.calories === 'number' ? per100g.calories : null;
    const proteinG = typeof per100g.protein_g === 'number' ? per100g.protein_g : null;
    const satFatG = typeof per100g.sat_fat_g === 'number' ? per100g.sat_fat_g : null;
    if (calories === null || proteinG === null || satFatG === null) continue;
    out.push({
      label,
      default_qty_g: defaultQty,
      per_100g: { calories, protein_g: proteinG, sat_fat_g: satFatG },
    });
  }
  return out;
}

/**
 * A record with no `components` but top-level calories/protein_g/sat_fat_g
 * is a single-item meal-bank entry (the contract's flat fields) — project
 * it as a one-component recipe assuming a 100g reference portion.
 */
function toSingleItemComponent(raw: MealBankRawRecord): RecipeComponent[] {
  const name = typeof raw.name === 'string' ? raw.name : null;
  const calories = typeof raw.calories === 'number' ? raw.calories : null;
  const proteinG = typeof raw.protein_g === 'number' ? raw.protein_g : null;
  const satFatG = typeof raw.sat_fat_g === 'number' ? raw.sat_fat_g : 0;
  if (!name || calories === null) return [];
  return [
    {
      label: name,
      default_qty_g: 100,
      per_100g: { calories, protein_g: proteinG ?? 0, sat_fat_g: satFatG },
    },
  ];
}

/**
 * Fixed epoch for sheet-recipe ULID derivation — only the seed (the recipe
 * name) should distinguish these ids, not wall time, so the same sheet
 * record always projects to the same identifier across reads.
 */
const SHEET_RECIPE_EPOCH_MS = 0;

function toRecipe(raw: MealBankRawRecord): RecipeRecord | null {
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
  if (!name) return null;
  const components = Array.isArray(raw.components) ? toComponents(raw.components) : toSingleItemComponent(raw);
  const now = new Date();
  return {
    ulid: ulidFromSeed(SHEET_RECIPE_EPOCH_MS, `mealbank:${name}`),
    name,
    components,
    source: 'sheet',
    created_at: now,
    updated_at: now,
  };
}

/**
 * Read the configured meal-bank sheet as `sheet`-sourced recipes. Degrades
 * to an empty list (never throws) when config is unset, the repo/sheet is
 * missing, or a record fails to parse — this is a read-through convenience,
 * not a required dependency.
 */
export async function readMealBankRecipes(
  config: MealBankConfig,
  log: FastifyBaseLogger
): Promise<RecipeRecord[]> {
  if (!config.repoPath || !config.sheetName) return [];

  try {
    const { openRepo } = await import('gitsheets');
    const repo = await openRepo({ gitDir: join(config.repoPath, '.git') });
    const sheet = await repo.openSheet(config.sheetName);
    const records = await sheet.queryAll();

    const recipes: RecipeRecord[] = [];
    for (const record of records as MealBankRawRecord[]) {
      const recipe = toRecipe(record);
      if (recipe) recipes.push(recipe);
    }
    return recipes;
  } catch (err) {
    log.warn(
      { err, repoPath: config.repoPath, sheetName: config.sheetName },
      'Meal-bank gitsheet read failed — degrading to recents-only reselect'
    );
    return [];
  }
}
