/**
 * Kitchen stores.
 *
 * `EntryStore`/`RecipeStore` are interfaces so the routes and pipeline are
 * testable without Postgres (see memory-store.ts). PgEntryStore/PgRecipeStore
 * are the production implementations over the `kitchen` schema. Mirrors
 * packages/capture/src/store.ts's shape and idioms.
 */

import type postgres from 'postgres';
import type {
  ComponentQuantity,
  EntryRecord,
  EntryStatus,
  EstimationSource,
  NutritionFields,
  RecipeComponent,
  RecipeRecord,
  RecipeSource,
} from './types.js';

/** Normalized insert payload for a new entry (validation already applied at the route). */
export interface NewEntry {
  ulid: string;
  logged_at: Date;
  note: string | null;
  recipe_ulid: string | null;
  component_quantities: ComponentQuantity[] | null;
}

/** Normalized insert payload for a new recipe. */
export interface NewRecipe {
  ulid: string;
  name: string;
  components: RecipeComponent[];
  source: RecipeSource;
}

/** A recent/frequent logged item, for the reselect strip. */
export interface RecentEntrySummary {
  label: string;
  calories: number | null;
  protein_g: number | null;
  fat_g: number | null;
  sat_fat_g: number | null;
  carbs_g: number | null;
  sodium_mg: number | null;
  last_logged_at: Date;
  log_count: number;
}

export interface EntryStore {
  /**
   * Idempotent insert: first write wins for identity fields (note,
   * recipe_ulid, component_quantities). Always inserts as
   * status='estimating', source=null — the pipeline resolves deterministic
   * entries (recipe-computed / reselect) via `applyEstimate` immediately
   * after. A replayed ULID whose row is still `estimating` returns the
   * existing record (created: false) so the pipeline can decide whether to
   * re-attempt estimation with freshly supplied photos — see
   * services/pipeline.ts.
   */
  insertIfAbsent(entry: NewEntry): Promise<{ record: EntryRecord; created: boolean }>;

  get(ulid: string): Promise<EntryRecord | null>;
  list(filter: { since?: Date; limit?: number }): Promise<EntryRecord[]>;

  /** Rows under the estimate-attempt cap, oldest first. */
  selectForEstimation(limit: number, maxAttempts: number): Promise<EntryRecord[]>;

  /** A model/reselect estimate succeeded. Resets attempts + clears error. */
  applyEstimate(
    ulid: string,
    label: string | null,
    nutrition: NutritionFields,
    source: EstimationSource,
    nextStatus: EntryStatus
  ): Promise<void>;
  /** Bump the attempt counter + record the error; status is unchanged. */
  recordEstimationFailure(ulid: string, error: string): Promise<number>;
  /** Attempts exhausted: move estimating → failed without touching nutrition. */
  applyEstimateCapped(ulid: string): Promise<void>;

  /**
   * The owner's macro override. Terminal — sets source='manual',
   * status='estimated'. Merges only the fields present in `nutrition`
   * (others keep their prior value); `label`/`note` update alongside when given.
   */
  applyManualOverride(
    ulid: string,
    nutrition: Partial<NutritionFields>,
    extra: { label?: string; note?: string }
  ): Promise<void>;

  /** A note/label edit re-queues estimation. Caller has already checked source !== 'manual'. */
  applyRequeue(ulid: string, extra: { label?: string; note?: string }): Promise<void>;

  delete(ulid: string): Promise<boolean>;

  /** Recent/frequent logged items for the reselect strip, most-recent first. */
  recentLabels(limit: number): Promise<RecentEntrySummary[]>;
}

export interface RecipeStore {
  insert(recipe: NewRecipe): Promise<RecipeRecord>;
  get(ulid: string): Promise<RecipeRecord | null>;
  /** Pushed + promoted recipes (DB-persisted only — sheet recipes are a read-through projection). */
  list(filter: { limit?: number }): Promise<RecipeRecord[]>;
}

export function normalizeNewEntry(
  input: { ulid: string; logged_at?: string; note?: string; recipe_ulid?: string; component_quantities?: ComponentQuantity[] },
  now = new Date()
): NewEntry {
  return {
    ulid: input.ulid,
    logged_at: input.logged_at ? new Date(input.logged_at) : now,
    note: input.note?.trim() ? input.note.trim() : null,
    recipe_ulid: input.recipe_ulid ?? null,
    component_quantities: input.component_quantities ?? null,
  };
}

export const EMPTY_NUTRITION: NutritionFields = {
  calories: null,
  protein_g: null,
  fat_g: null,
  sat_fat_g: null,
  carbs_g: null,
  sodium_mg: null,
  confidence: null,
  portion_basis: null,
};

/** Parse a JSONB field that may come back as a string from postgres.js */
function parseJsonField<T>(value: T | string | null): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

/** Parse a NUMERIC field that postgres.js returns as a string */
function parseNumeric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const parsed = parseFloat(value as string);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowToEntry(row: Record<string, unknown>): EntryRecord {
  return {
    ulid: row.ulid as string,
    logged_at: row.logged_at as Date,
    received_at: row.received_at as Date,
    note: (row.note as string | null) ?? null,
    label: (row.label as string | null) ?? null,
    calories: parseNumeric(row.calories),
    protein_g: parseNumeric(row.protein_g),
    fat_g: parseNumeric(row.fat_g),
    sat_fat_g: parseNumeric(row.sat_fat_g),
    carbs_g: parseNumeric(row.carbs_g),
    sodium_mg: parseNumeric(row.sodium_mg),
    confidence: parseNumeric(row.confidence),
    portion_basis: (row.portion_basis as string | null) ?? null,
    source: (row.source as EstimationSource | null) ?? null,
    status: row.status as EntryStatus,
    estimate_attempts: Number(row.estimate_attempts ?? 0),
    last_error: (row.last_error as string | null) ?? null,
    last_error_at: (row.last_error_at as Date | null) ?? null,
    recipe_ulid: (row.recipe_ulid as string | null) ?? null,
    component_quantities: parseJsonField<ComponentQuantity[]>(
      row.component_quantities as ComponentQuantity[] | string | null
    ),
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

function rowToRecipe(row: Record<string, unknown>): RecipeRecord {
  return {
    ulid: row.ulid as string,
    name: row.name as string,
    components: parseJsonField<RecipeComponent[]>(row.components as RecipeComponent[] | string) ?? [],
    source: row.source as RecipeSource,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

export class PgEntryStore implements EntryStore {
  constructor(private sql: postgres.Sql) {}

  async insertIfAbsent(entry: NewEntry): Promise<{ record: EntryRecord; created: boolean }> {
    const inserted = await this.sql`
      INSERT INTO kitchen.entries
        (ulid, logged_at, note, recipe_ulid, component_quantities, status)
      VALUES (
        ${entry.ulid}, ${entry.logged_at}, ${entry.note}, ${entry.recipe_ulid},
        ${entry.component_quantities ? JSON.stringify(entry.component_quantities) : null},
        'estimating'
      )
      ON CONFLICT (ulid) DO NOTHING
      RETURNING *
    `;

    if (inserted.length > 0) {
      return { record: rowToEntry(inserted[0]!), created: true };
    }

    const existing = await this.get(entry.ulid);
    if (!existing) {
      throw new Error(`Entry ${entry.ulid} conflicted on insert but is not readable`);
    }
    return { record: existing, created: false };
  }

  async get(ulid: string): Promise<EntryRecord | null> {
    const [row] = await this.sql`SELECT * FROM kitchen.entries WHERE ulid = ${ulid}`;
    return row ? rowToEntry(row) : null;
  }

  async list(filter: { since?: Date; limit?: number }): Promise<EntryRecord[]> {
    const limit = Math.min(filter.limit ?? 50, 500);
    const rows = filter.since
      ? await this.sql`
          SELECT * FROM kitchen.entries WHERE logged_at > ${filter.since}
          ORDER BY logged_at DESC LIMIT ${limit}
        `
      : await this.sql`
          SELECT * FROM kitchen.entries ORDER BY logged_at DESC LIMIT ${limit}
        `;
    return rows.map(rowToEntry);
  }

  async selectForEstimation(limit: number, maxAttempts: number): Promise<EntryRecord[]> {
    const rows = await this.sql`
      SELECT * FROM kitchen.entries
      WHERE status = 'estimating' AND estimate_attempts < ${maxAttempts}
      ORDER BY logged_at ASC
      LIMIT ${limit}
    `;
    return rows.map(rowToEntry);
  }

  async applyEstimate(
    ulid: string,
    label: string | null,
    nutrition: NutritionFields,
    source: EstimationSource,
    nextStatus: EntryStatus
  ): Promise<void> {
    await this.sql`
      UPDATE kitchen.entries SET
        calories = ${nutrition.calories}, protein_g = ${nutrition.protein_g},
        fat_g = ${nutrition.fat_g}, sat_fat_g = ${nutrition.sat_fat_g},
        carbs_g = ${nutrition.carbs_g}, sodium_mg = ${nutrition.sodium_mg},
        confidence = ${nutrition.confidence}, portion_basis = ${nutrition.portion_basis},
        label = COALESCE(${label}, label),
        source = ${source}, status = ${nextStatus},
        estimate_attempts = 0, last_error = NULL, last_error_at = NULL
      WHERE ulid = ${ulid}
    `;
  }

  async recordEstimationFailure(ulid: string, error: string): Promise<number> {
    const [row] = await this.sql<{ estimate_attempts: number }[]>`
      UPDATE kitchen.entries SET
        estimate_attempts = estimate_attempts + 1,
        last_error = ${error}, last_error_at = NOW()
      WHERE ulid = ${ulid}
      RETURNING estimate_attempts
    `;
    return row?.estimate_attempts ?? 0;
  }

  async applyEstimateCapped(ulid: string): Promise<void> {
    await this.sql`UPDATE kitchen.entries SET status = 'failed' WHERE ulid = ${ulid}`;
  }

  async applyManualOverride(
    ulid: string,
    nutrition: Partial<NutritionFields>,
    extra: { label?: string; note?: string }
  ): Promise<void> {
    const current = await this.get(ulid);
    if (!current) throw new Error(`Entry not found: ${ulid}`);
    const merged: NutritionFields = { ...current, ...nutrition };
    await this.sql`
      UPDATE kitchen.entries SET
        calories = ${merged.calories}, protein_g = ${merged.protein_g},
        fat_g = ${merged.fat_g}, sat_fat_g = ${merged.sat_fat_g},
        carbs_g = ${merged.carbs_g}, sodium_mg = ${merged.sodium_mg},
        confidence = NULL, portion_basis = ${merged.portion_basis},
        label = ${extra.label ?? current.label}, note = ${extra.note ?? current.note},
        source = 'manual', status = 'estimated',
        last_error = NULL, last_error_at = NULL
      WHERE ulid = ${ulid}
    `;
  }

  async applyRequeue(ulid: string, extra: { label?: string; note?: string }): Promise<void> {
    const current = await this.get(ulid);
    if (!current) throw new Error(`Entry not found: ${ulid}`);
    await this.sql`
      UPDATE kitchen.entries SET
        label = ${extra.label ?? current.label}, note = ${extra.note ?? current.note},
        status = 'estimating', estimate_attempts = 0,
        last_error = NULL, last_error_at = NULL
      WHERE ulid = ${ulid}
    `;
  }

  async delete(ulid: string): Promise<boolean> {
    const rows = await this.sql`DELETE FROM kitchen.entries WHERE ulid = ${ulid} RETURNING ulid`;
    return rows.length > 0;
  }

  async recentLabels(limit: number): Promise<RecentEntrySummary[]> {
    const rows = await this.sql`
      SELECT
        label,
        (array_agg(calories ORDER BY logged_at DESC))[1] AS calories,
        (array_agg(protein_g ORDER BY logged_at DESC))[1] AS protein_g,
        (array_agg(fat_g ORDER BY logged_at DESC))[1] AS fat_g,
        (array_agg(sat_fat_g ORDER BY logged_at DESC))[1] AS sat_fat_g,
        (array_agg(carbs_g ORDER BY logged_at DESC))[1] AS carbs_g,
        (array_agg(sodium_mg ORDER BY logged_at DESC))[1] AS sodium_mg,
        MAX(logged_at) AS last_logged_at,
        COUNT(*)::int AS log_count
      FROM kitchen.entries
      WHERE label IS NOT NULL AND status = 'estimated'
      GROUP BY label
      ORDER BY MAX(logged_at) DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      label: row.label as string,
      calories: parseNumeric(row.calories),
      protein_g: parseNumeric(row.protein_g),
      fat_g: parseNumeric(row.fat_g),
      sat_fat_g: parseNumeric(row.sat_fat_g),
      carbs_g: parseNumeric(row.carbs_g),
      sodium_mg: parseNumeric(row.sodium_mg),
      last_logged_at: row.last_logged_at as Date,
      log_count: Number(row.log_count),
    }));
  }
}

export class PgRecipeStore implements RecipeStore {
  constructor(private sql: postgres.Sql) {}

  async insert(recipe: NewRecipe): Promise<RecipeRecord> {
    const [row] = await this.sql`
      INSERT INTO kitchen.recipes (ulid, name, components, source)
      VALUES (${recipe.ulid}, ${recipe.name}, ${JSON.stringify(recipe.components)}, ${recipe.source})
      RETURNING *
    `;
    return rowToRecipe(row!);
  }

  async get(ulid: string): Promise<RecipeRecord | null> {
    const [row] = await this.sql`SELECT * FROM kitchen.recipes WHERE ulid = ${ulid}`;
    return row ? rowToRecipe(row) : null;
  }

  async list(filter: { limit?: number }): Promise<RecipeRecord[]> {
    const limit = Math.min(filter.limit ?? 100, 500);
    const rows = await this.sql`
      SELECT * FROM kitchen.recipes ORDER BY name ASC LIMIT ${limit}
    `;
    return rows.map(rowToRecipe);
  }
}
