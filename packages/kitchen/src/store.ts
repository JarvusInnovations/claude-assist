/**
 * Kitchen stores.
 *
 * `EntryStore`/`RecipeStore` are interfaces so the routes and pipeline are
 * testable without Postgres (see memory-store.ts). PgEntryStore/PgRecipeStore
 * are the production implementations over the `kitchen` schema. Mirrors
 * packages/capture/src/store.ts's shape and idioms.
 */

import type postgres from 'postgres';
import { coerceBareDateToLocalNoon } from './date-coerce.js';
import type {
  ComponentQuantity,
  ConsumptionAmount,
  EntryConsumptionRecord,
  EntryRecord,
  EntryStatus,
  EstimateExclusion,
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
  /**
   * FALSE only when a HUMAN supplied `note` and nobody has reconciled it against
   * the panel yet (specs/modules/kitchen.md § Unreviewed entry notes). Defaults
   * to TRUE — "nothing to review" is the resting state, and being unreviewed is
   * an explicit assertion made by the caller that knows the note's provenance.
   * An agent-composed note (a worksheet's measured-provenance manifest, say) is
   * not a human statement and must never flag.
   */
  notes_reviewed: boolean;
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
  /**
   * The source entry this summary points at — the most-recent estimated
   * occurrence of `label`. A recent pill re-logs by POSTing
   * `reselect_of: entry_ulid`, which clones this entry (specs/modules/kitchen.md
   * § Reselect cloning).
   */
  entry_ulid: string;
  label: string;
  calories: number | null;
  protein_g: number | null;
  fat_g: number | null;
  sat_fat_g: number | null;
  carbs_g: number | null;
  sugar_g: number | null;
  added_sugar_g: number | null;
  fiber_g: number | null;
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

  /**
   * A model/reselect estimate succeeded. Resets attempts + clears error.
   *
   * `excludedLines` is the estimator's non-food exclusion report
   * (§ Billing artifacts are not ingredients) — optional, since only the model
   * path produces one, and `null`/omitted stores nothing.
   */
  applyEstimate(
    ulid: string,
    label: string | null,
    nutrition: NutritionFields,
    source: EstimationSource,
    nextStatus: EntryStatus,
    excludedLines?: EstimateExclusion[] | null
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

  /**
   * Entries whose human-supplied note nobody has reconciled against the panel
   * (specs/modules/kitchen.md § Unreviewed entry notes), oldest first — the
   * entries-side twin of the inventory needs-info queue.
   */
  listUnreviewedNotes(limit?: number): Promise<EntryRecord[]>;

  /** Count of the above, for the home view's open-question total. */
  countUnreviewedNotes(): Promise<number>;

  /**
   * Mark a note looked at. Touches ONLY that column: reviewing records that a
   * human read the note, NOT that anything changed. Correcting the panel is a
   * separate `patch` — conflating them would push toward pointless edits made
   * only to clear a flag.
   */
  markNotesReviewed(ulid: string): Promise<boolean>;

  /**
   * Set the post-hoc portion multiplier. Touches ONLY that column — no source
   * change, no status change, no re-queue (specs/modules/kitchen.md § Portion
   * multiplier). Caller has already range-validated the value.
   */
  applyPortionMultiplier(ulid: string, multiplier: number): Promise<void>;

  /**
   * Backdate the entry to a new `logged_at`. Touches ONLY that column — no
   * source change, no status change, no re-queue (specs/modules/kitchen.md
   * § Logged-at backdating). Caller has already parsed + bounds-validated the
   * value. Rollups re-bucket by `logged_at` at query time, so nothing else
   * moves.
   */
  applyLoggedAt(ulid: string, loggedAt: Date): Promise<void>;

  delete(ulid: string): Promise<boolean>;

  /** Recent/frequent logged items for the reselect strip, most-recent first. */
  recentLabels(limit: number): Promise<RecentEntrySummary[]>;

  /**
   * Record that an entry's consumption decremented an inventory item: a
   * `kitchen.entry_consumptions` row (specs/modules/kitchen.md § Data model),
   * plus the derived `entries.inventory_item_ulid` when that is still empty.
   *
   * Idempotent on the PAIR — re-linking the same `(entry, item)` keeps the
   * first row and its amount. A DIFFERENT item under the same entry is the next
   * component of the same meal, not a conflict.
   *
   * `applied` is the decrement as it landed on the item's own unit model;
   * omitted when the caller genuinely doesn't know it.
   */
  linkInventoryItem(entryUlid: string, itemUlid: string, applied?: ConsumptionAmount): Promise<void>;

  /** Every item one entry depleted, oldest link first. */
  listConsumptions(entryUlid: string): Promise<EntryConsumptionRecord[]>;

  /**
   * Move every entry that depleted one item onto another, returning how many
   * DISTINCT entries moved — the entries half of an item merge
   * (specs/modules/kitchen.md § Item corrections). Lives here rather than on the
   * inventory store because `kitchen.entries` is this store's table; the
   * inventory pipeline reaches it through an injected hook, the same seam
   * `linkInventoryItem` uses.
   *
   * **Collapses on collision.** One entry may have depleted BOTH rows of a
   * duplicate — the ordinary consequence of two records for one package — and
   * the pair key forbids two rows for `(entry, survivor)`. The colliding rows
   * fold into one: amounts ADD when both are known and share a kind, and the
   * survivor's row is kept untouched otherwise, because a fraction and a unit
   * count cannot be added honestly.
   */
  relinkInventoryItem(fromItemUlid: string, toItemUlid: string): Promise<number>;
}

export interface RecipeStore {
  insert(recipe: NewRecipe): Promise<RecipeRecord>;
  /**
   * By ULID, **archived rows included** (§ Recipe corrections): an entry's
   * `recipe_ulid`, a promote's component reconstruction, and a derived item's
   * derivation provenance must keep resolving after a recipe is retired.
   */
  get(ulid: string): Promise<RecipeRecord | null>;
  /**
   * Live pushed + promoted recipes — archived rows excluded, so a retired
   * recipe can never be tapped again (sheet recipes are a read-through
   * projection and never appear here).
   */
  list(filter: { limit?: number }): Promise<RecipeRecord[]>;
  /**
   * Every LIVE recipe whose name normalizes to `normalizedName` — the
   * upsert-on-name key lookup (§ Recipe corrections). Returns all matches, not
   * the first: more than one is a pre-existing fork the upsert must refuse to
   * resolve by guessing, and the caller needs every candidate to say so.
   */
  findLiveByNormalizedName(normalizedName: string): Promise<RecipeRecord[]>;
  /**
   * Overwrite an existing recipe's name + components in place, bumping
   * `updated_at`. `ulid`, `created_at`, and `source` are preserved — a
   * correction replaces the record, it does not re-found it. Null when the ULID
   * is unknown.
   */
  replace(ulid: string, update: { name: string; components: RecipeComponent[] }): Promise<RecipeRecord | null>;
  /**
   * Stamp `archived_at` (idempotent — an already-archived row keeps its
   * original stamp and is returned unchanged). Null when the ULID is unknown.
   */
  archive(ulid: string): Promise<RecipeRecord | null>;
}

export function normalizeNewEntry(
  input: {
    ulid: string;
    logged_at?: string;
    note?: string;
    recipe_ulid?: string;
    component_quantities?: ComponentQuantity[];
    /** The note was written by a human, so it needs a look (§ Unreviewed entry notes). */
    human_note?: boolean;
  },
  now = new Date()
): NewEntry {
  return {
    ulid: input.ulid,
    // A bare `YYYY-MM-DD` logged_at coerces to local noon (specs/modules/
    // kitchen.md § Logged-at backdating) before parsing, so it buckets on the
    // intended day rather than midnight-UTC's previous evening. A full
    // timestamp passes through coerceBareDateToLocalNoon unchanged.
    logged_at: input.logged_at ? new Date(coerceBareDateToLocalNoon(input.logged_at)) : now,
    note: input.note?.trim() ? input.note.trim() : null,
    recipe_ulid: input.recipe_ulid ?? null,
    component_quantities: input.component_quantities ?? null,
    // Only a human note that actually has content flags: `human_note` on an
    // empty note would queue a question about nothing.
    notes_reviewed: !(input.human_note && input.note?.trim()),
  };
}

export const EMPTY_NUTRITION: NutritionFields = {
  calories: null,
  protein_g: null,
  fat_g: null,
  sat_fat_g: null,
  carbs_g: null,
  sugar_g: null,
  added_sugar_g: null,
  fiber_g: null,
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

/**
 * Map a `kitchen.entry_consumptions` row. Exported for the same reason
 * `rowToEntry` below is — `services/consume-store.ts` writes and reads this
 * table from the inventory side and must not carry a second copy of the
 * mapping.
 */
export function rowToEntryConsumption(row: Record<string, unknown>): EntryConsumptionRecord {
  return {
    entry_ulid: row.entry_ulid as string,
    item_ulid: row.item_ulid as string,
    amount: row.amount == null ? null : Number(row.amount),
    amount_kind: (row.amount_kind as EntryConsumptionRecord['amount_kind']) ?? null,
    created_at: row.created_at as Date,
  };
}

/**
 * Exported so `services/consume-store.ts` (claude-assist#110's atomic
 * entry+deplete write, which crosses into `kitchen.entries` from the
 * inventory side of the module) can map a raw entries row without
 * duplicating this mapping — the two stores must never drift on what an
 * entries row means.
 */
export function rowToEntry(row: Record<string, unknown>): EntryRecord {
  return {
    ulid: row.ulid as string,
    logged_at: row.logged_at as Date,
    received_at: row.received_at as Date,
    note: (row.note as string | null) ?? null,
    notes_reviewed: (row.notes_reviewed as boolean | undefined) ?? true,
    label: (row.label as string | null) ?? null,
    calories: parseNumeric(row.calories),
    protein_g: parseNumeric(row.protein_g),
    fat_g: parseNumeric(row.fat_g),
    sat_fat_g: parseNumeric(row.sat_fat_g),
    carbs_g: parseNumeric(row.carbs_g),
    sugar_g: parseNumeric(row.sugar_g),
    added_sugar_g: parseNumeric(row.added_sugar_g),
    fiber_g: parseNumeric(row.fiber_g),
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
    excluded_lines: parseJsonField<EstimateExclusion[]>(
      row.excluded_lines as EstimateExclusion[] | string | null
    ),
    portion_multiplier: parseNumeric(row.portion_multiplier) ?? 1,
    inventory_item_ulid: (row.inventory_item_ulid as string | null) ?? null,
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
    archived_at: (row.archived_at as Date | null) ?? null,
  };
}

export class PgEntryStore implements EntryStore {
  constructor(private sql: postgres.Sql) {}

  async insertIfAbsent(entry: NewEntry): Promise<{ record: EntryRecord; created: boolean }> {
    const inserted = await this.sql`
      INSERT INTO kitchen.entries
        (ulid, logged_at, note, recipe_ulid, component_quantities, status, notes_reviewed)
      VALUES (
        ${entry.ulid}, ${entry.logged_at}, ${entry.note}, ${entry.recipe_ulid},
        ${entry.component_quantities ? this.sql.json(entry.component_quantities as never) : null},
        'estimating', ${entry.notes_reviewed}
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
    nextStatus: EntryStatus,
    excludedLines?: EstimateExclusion[] | null
  ): Promise<void> {
    // An empty report and no report are the same fact — nothing was excluded —
    // so both store NULL rather than an empty array a reader has to interpret.
    const excluded = excludedLines && excludedLines.length > 0 ? JSON.stringify(excludedLines) : null;
    await this.sql`
      UPDATE kitchen.entries SET
        excluded_lines = ${excluded}::jsonb,
        calories = ${nutrition.calories}, protein_g = ${nutrition.protein_g},
        fat_g = ${nutrition.fat_g}, sat_fat_g = ${nutrition.sat_fat_g},
        carbs_g = ${nutrition.carbs_g}, sugar_g = ${nutrition.sugar_g},
        added_sugar_g = ${nutrition.added_sugar_g},
        fiber_g = ${nutrition.fiber_g}, sodium_mg = ${nutrition.sodium_mg},
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
        carbs_g = ${merged.carbs_g}, sugar_g = ${merged.sugar_g},
        added_sugar_g = ${merged.added_sugar_g},
        fiber_g = ${merged.fiber_g}, sodium_mg = ${merged.sodium_mg},
        confidence = NULL, portion_basis = ${merged.portion_basis},
        label = ${extra.label ?? current.label}, note = ${extra.note ?? current.note},
        source = 'manual', status = 'estimated',
        -- A note supplied on patch is the owner speaking, so it needs a look
        -- again; a macro-only patch leaves the flag alone.
        notes_reviewed = ${extra.note?.trim() ? false : current.notes_reviewed},
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
        notes_reviewed = ${extra.note?.trim() ? false : current.notes_reviewed},
        last_error = NULL, last_error_at = NULL
      WHERE ulid = ${ulid}
    `;
  }

  async listUnreviewedNotes(limit = 50): Promise<EntryRecord[]> {
    const rows = await this.sql`
      SELECT * FROM kitchen.entries
      WHERE notes_reviewed = FALSE
      ORDER BY logged_at ASC
      LIMIT ${limit}
    `;
    return rows.map((r: Record<string, unknown>) => rowToEntry(r));
  }

  async countUnreviewedNotes(): Promise<number> {
    const rows = await this.sql`
      SELECT COUNT(*)::int AS n FROM kitchen.entries WHERE notes_reviewed = FALSE
    `;
    return Number(rows[0]?.n ?? 0);
  }

  async markNotesReviewed(ulid: string): Promise<boolean> {
    const rows = await this.sql`
      UPDATE kitchen.entries SET notes_reviewed = TRUE
      WHERE ulid = ${ulid} AND notes_reviewed = FALSE
      RETURNING ulid
    `;
    return rows.length > 0;
  }

  async applyPortionMultiplier(ulid: string, multiplier: number): Promise<void> {
    await this.sql`
      UPDATE kitchen.entries SET portion_multiplier = ${multiplier} WHERE ulid = ${ulid}
    `;
  }

  async applyLoggedAt(ulid: string, loggedAt: Date): Promise<void> {
    await this.sql`
      UPDATE kitchen.entries SET logged_at = ${loggedAt} WHERE ulid = ${ulid}
    `;
  }

  async delete(ulid: string): Promise<boolean> {
    const rows = await this.sql`DELETE FROM kitchen.entries WHERE ulid = ${ulid} RETURNING ulid`;
    return rows.length > 0;
  }

  async linkInventoryItem(
    entryUlid: string,
    itemUlid: string,
    applied?: ConsumptionAmount
  ): Promise<void> {
    // One transaction: the row and the derived column are two statements
    // expressing ONE fact. Splitting them leaves a window where the link is
    // recorded but the matcher's "already depleted" guard is not, and a
    // re-estimate would then take another step off the shelf.
    await this.sql.begin(async (rawTx) => {
      const tx = rawTx as unknown as postgres.Sql;
      // The authoritative record. DO NOTHING rather than DO UPDATE: a second
      // link of the same pair is a REPLAY, and the first write's amount is the
      // one that matched a real decrement.
      await tx`
        INSERT INTO kitchen.entry_consumptions (entry_ulid, item_ulid, amount, amount_kind)
        VALUES (${entryUlid}, ${itemUlid}, ${applied?.amount ?? null}, ${applied?.amount_kind ?? null})
        ON CONFLICT (entry_ulid, item_ulid) DO NOTHING
      `;
      // The derived column names the FIRST item only — a later component must
      // not overwrite it, or the guard above would keep sliding forward and the
      // wire shape would report the last link as if it were the one.
      await tx`
        UPDATE kitchen.entries SET inventory_item_ulid = ${itemUlid}
        WHERE ulid = ${entryUlid} AND inventory_item_ulid IS NULL
      `;
    });
  }

  async listConsumptions(entryUlid: string): Promise<EntryConsumptionRecord[]> {
    const rows = await this.sql`
      SELECT * FROM kitchen.entry_consumptions
      WHERE entry_ulid = ${entryUlid}
      ORDER BY created_at ASC, item_ulid ASC
    `;
    return rows.map(rowToEntryConsumption);
  }

  async relinkInventoryItem(fromItemUlid: string, toItemUlid: string): Promise<number> {
    return this.sql.begin(async (rawTx) => {
      const tx = rawTx as unknown as postgres.Sql;

      // Sequential statements, not one data-modifying CTE: every CTE in a
      // statement sees the same snapshot, so the final repoint would still find
      // the rows the collapse deleted and re-collide on the pair key.

      // 1. Fold each colliding loser row into the survivor's. Amounts add only
      //    when both are known and share a kind — a fraction and a unit count
      //    have no honest sum, and there the survivor's row stands as it is.
      const collapsed = await tx`
        UPDATE kitchen.entry_consumptions t SET
          amount = CASE
            WHEN t.amount IS NOT NULL AND f.amount IS NOT NULL AND t.amount_kind = f.amount_kind
              THEN t.amount + f.amount
            ELSE t.amount
          END
        FROM kitchen.entry_consumptions f
        WHERE f.item_ulid = ${fromItemUlid}
          AND f.entry_ulid = t.entry_ulid
          AND t.item_ulid = ${toItemUlid}
        RETURNING t.entry_ulid
      `;

      // 2. Drop the now-folded loser rows.
      await tx`
        DELETE FROM kitchen.entry_consumptions f
        WHERE f.item_ulid = ${fromItemUlid}
          AND EXISTS (
            SELECT 1 FROM kitchen.entry_consumptions t
            WHERE t.entry_ulid = f.entry_ulid AND t.item_ulid = ${toItemUlid}
          )
      `;

      // 3. Repoint what is left — no collision possible now.
      const moved = await tx`
        UPDATE kitchen.entry_consumptions SET item_ulid = ${toItemUlid}
        WHERE item_ulid = ${fromItemUlid}
        RETURNING entry_ulid
      `;

      // The derived column follows; it is single-valued, so it cannot collide.
      await tx`
        UPDATE kitchen.entries SET inventory_item_ulid = ${toItemUlid}
        WHERE inventory_item_ulid = ${fromItemUlid}
      `;

      const entries = new Set<string>([
        ...collapsed.map((r) => r.entry_ulid as string),
        ...moved.map((r) => r.entry_ulid as string),
      ]);
      return entries.size;
    });
  }

  async recentLabels(limit: number): Promise<RecentEntrySummary[]> {
    const rows = await this.sql`
      SELECT
        label,
        (array_agg(ulid ORDER BY logged_at DESC))[1] AS entry_ulid,
        (array_agg(calories ORDER BY logged_at DESC))[1] AS calories,
        (array_agg(protein_g ORDER BY logged_at DESC))[1] AS protein_g,
        (array_agg(fat_g ORDER BY logged_at DESC))[1] AS fat_g,
        (array_agg(sat_fat_g ORDER BY logged_at DESC))[1] AS sat_fat_g,
        (array_agg(carbs_g ORDER BY logged_at DESC))[1] AS carbs_g,
        (array_agg(sugar_g ORDER BY logged_at DESC))[1] AS sugar_g,
        (array_agg(added_sugar_g ORDER BY logged_at DESC))[1] AS added_sugar_g,
        (array_agg(fiber_g ORDER BY logged_at DESC))[1] AS fiber_g,
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
      entry_ulid: row.entry_ulid as string,
      label: row.label as string,
      calories: parseNumeric(row.calories),
      protein_g: parseNumeric(row.protein_g),
      fat_g: parseNumeric(row.fat_g),
      sat_fat_g: parseNumeric(row.sat_fat_g),
      carbs_g: parseNumeric(row.carbs_g),
      sugar_g: parseNumeric(row.sugar_g),
      added_sugar_g: parseNumeric(row.added_sugar_g),
      fiber_g: parseNumeric(row.fiber_g),
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
      VALUES (${recipe.ulid}, ${recipe.name}, ${this.sql.json(recipe.components as never)}, ${recipe.source})
      RETURNING *
    `;
    return rowToRecipe(row!);
  }

  // Archived rows deliberately included — history must keep resolving.
  async get(ulid: string): Promise<RecipeRecord | null> {
    const [row] = await this.sql`SELECT * FROM kitchen.recipes WHERE ulid = ${ulid}`;
    return row ? rowToRecipe(row) : null;
  }

  async list(filter: { limit?: number }): Promise<RecipeRecord[]> {
    const limit = Math.min(filter.limit ?? 100, 500);
    const rows = await this.sql`
      SELECT * FROM kitchen.recipes
      WHERE archived_at IS NULL
      ORDER BY name ASC LIMIT ${limit}
    `;
    return rows.map(rowToRecipe);
  }

  async findLiveByNormalizedName(normalizedName: string): Promise<RecipeRecord[]> {
    // Normalization mirrors normalizeRecipeName() exactly: trim, collapse
    // internal whitespace, case-fold.
    const rows = await this.sql`
      SELECT * FROM kitchen.recipes
      WHERE archived_at IS NULL
        AND lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = ${normalizedName}
      ORDER BY created_at ASC
    `;
    return rows.map(rowToRecipe);
  }

  async replace(
    ulid: string,
    update: { name: string; components: RecipeComponent[] }
  ): Promise<RecipeRecord | null> {
    const [row] = await this.sql`
      UPDATE kitchen.recipes
      SET name = ${update.name},
          components = ${this.sql.json(update.components as never)},
          updated_at = NOW()
      WHERE ulid = ${ulid}
      RETURNING *
    `;
    return row ? rowToRecipe(row) : null;
  }

  async archive(ulid: string): Promise<RecipeRecord | null> {
    // COALESCE keeps the original stamp on a repeat archive (idempotent).
    const [row] = await this.sql`
      UPDATE kitchen.recipes
      SET archived_at = COALESCE(archived_at, NOW())
      WHERE ulid = ${ulid}
      RETURNING *
    `;
    return row ? rowToRecipe(row) : null;
  }
}

// ── Expenditures (§ Expenditure & net energy, claude-assist#121) ─────────────

/** A row in kitchen.expenditures — a stated activity/burn, never estimated. */
export interface ExpenditureRecord {
  ulid: string;
  occurred_at: Date;
  source: 'strava' | 'health_connect' | 'garmin' | 'manual';
  label: string;
  /** Active calories, not gross. */
  kcal: number;
  duration_min: number | null;
  avg_hr: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface NewExpenditure {
  ulid: string;
  occurred_at: Date;
  source: ExpenditureRecord['source'];
  label: string;
  kcal: number;
  duration_min?: number | null;
  avg_hr?: number | null;
}

export interface ExpenditureStore {
  /** Idempotent on ulid (feed re-pulls replay safely). */
  insertIfAbsent(row: NewExpenditure): Promise<{ record: ExpenditureRecord; created: boolean }>;
  list(filter: { since?: Date; until?: Date; limit?: number }): Promise<ExpenditureRecord[]>;
  delete(ulid: string): Promise<boolean>;
  /**
   * Which of these ulids already exist — the Strava sync's unseen filter
   * (§ Strava activity sync: detail calls happen only for unseen activities,
   * so this cheap bulk lookup is what keeps steady-state API usage at one
   * list call per tick).
   */
  existingUlids(ulids: string[]): Promise<Set<string>>;
}

function rowToExpenditure(row: Record<string, unknown>): ExpenditureRecord {
  return {
    ulid: row.ulid as string,
    occurred_at: row.occurred_at as Date,
    source: row.source as ExpenditureRecord['source'],
    label: row.label as string,
    kcal: Number(row.kcal),
    duration_min: row.duration_min == null ? null : Number(row.duration_min),
    avg_hr: row.avg_hr == null ? null : Number(row.avg_hr),
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

export class PgExpenditureStore implements ExpenditureStore {
  constructor(private sql: postgres.Sql) {}

  async insertIfAbsent(row: NewExpenditure): Promise<{ record: ExpenditureRecord; created: boolean }> {
    const inserted = await this.sql`
      INSERT INTO kitchen.expenditures (ulid, occurred_at, source, label, kcal, duration_min, avg_hr)
      VALUES (${row.ulid}, ${row.occurred_at}, ${row.source}, ${row.label},
              ${row.kcal}, ${row.duration_min ?? null}, ${row.avg_hr ?? null})
      ON CONFLICT (ulid) DO NOTHING
      RETURNING *
    `;
    if (inserted.length > 0) return { record: rowToExpenditure(inserted[0]!), created: true };
    const [existing] = await this.sql`SELECT * FROM kitchen.expenditures WHERE ulid = ${row.ulid}`;
    if (!existing) throw new Error(`Expenditure ${row.ulid} conflicted on insert but is not readable`);
    return { record: rowToExpenditure(existing), created: false };
  }

  async list(filter: { since?: Date; until?: Date; limit?: number }): Promise<ExpenditureRecord[]> {
    const limit = Math.min(filter.limit ?? 100, 500);
    const since = filter.since ?? new Date(0);
    const until = filter.until ?? new Date('9999-01-01');
    const rows = await this.sql`
      SELECT * FROM kitchen.expenditures
      WHERE occurred_at >= ${since} AND occurred_at < ${until}
      ORDER BY occurred_at DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToExpenditure);
  }

  async delete(ulid: string): Promise<boolean> {
    const result = await this.sql`DELETE FROM kitchen.expenditures WHERE ulid = ${ulid} RETURNING ulid`;
    return result.length > 0;
  }

  async existingUlids(ulids: string[]): Promise<Set<string>> {
    if (ulids.length === 0) return new Set();
    const rows = await this.sql`
      SELECT ulid FROM kitchen.expenditures WHERE ulid IN ${this.sql(ulids)}
    `;
    return new Set(rows.map((row) => row.ulid as string));
  }
}

// ── Strava OAuth custody (§ Strava activity sync) ────────────────────────────

/**
 * The single kitchen.strava_oauth row — the CURRENT Strava token set.
 * Strava rotates the refresh token on every refresh, so this row (not the
 * env seed) is authoritative once it exists.
 */
export interface StravaOAuthState {
  refresh_token: string;
  access_token: string | null;
  expires_at: Date | null;
  updated_at: Date;
}

export interface StravaOAuthStore {
  get(): Promise<StravaOAuthState | null>;
  /**
   * First-boot seed: insert the env refresh token if (and only if) no row
   * exists yet. Returns the stored state either way — a concurrent or prior
   * row wins, the seed is ignored (§ Strava activity sync token custody).
   */
  seed(refreshToken: string): Promise<StravaOAuthState>;
  /** Persist a rotated token set (upsert onto the single row). */
  save(state: { refresh_token: string; access_token: string | null; expires_at: Date | null }): Promise<void>;
}

function rowToStravaOAuth(row: Record<string, unknown>): StravaOAuthState {
  return {
    refresh_token: row.refresh_token as string,
    access_token: (row.access_token as string | null) ?? null,
    expires_at: (row.expires_at as Date | null) ?? null,
    updated_at: row.updated_at as Date,
  };
}

export class PgStravaOAuthStore implements StravaOAuthStore {
  constructor(private sql: postgres.Sql) {}

  async get(): Promise<StravaOAuthState | null> {
    const [row] = await this.sql`SELECT * FROM kitchen.strava_oauth WHERE id = 1`;
    return row ? rowToStravaOAuth(row) : null;
  }

  async seed(refreshToken: string): Promise<StravaOAuthState> {
    await this.sql`
      INSERT INTO kitchen.strava_oauth (id, refresh_token)
      VALUES (1, ${refreshToken})
      ON CONFLICT (id) DO NOTHING
    `;
    const state = await this.get();
    if (!state) throw new Error('kitchen.strava_oauth row missing immediately after seed');
    return state;
  }

  async save(state: { refresh_token: string; access_token: string | null; expires_at: Date | null }): Promise<void> {
    await this.sql`
      INSERT INTO kitchen.strava_oauth (id, refresh_token, access_token, expires_at, updated_at)
      VALUES (1, ${state.refresh_token}, ${state.access_token}, ${state.expires_at}, now())
      ON CONFLICT (id) DO UPDATE SET
        refresh_token = EXCLUDED.refresh_token,
        access_token = EXCLUDED.access_token,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    `;
  }
}

// ── Weigh-ins (§ Weigh-ins — scale data via the capture app, claude-assist#121) ──

/**
 * A row in kitchen.weigh_ins — one reading, transcribed verbatim. Repeats
 * and multi-writer noise are collapsed at read time only (daily median).
 */
export interface WeighInRecord {
  ulid: string;
  /** The reading's instant (UTC — timestamptz normalizes the offset away). */
  occurred_at: Date;
  /**
   * Minutes east of UTC from the POSTed occurred_at's explicit offset —
   * preserved so day bucketing honors the reading's OWN local day, never
   * a server-zone guess.
   */
  tz_offset_minutes: number;
  weight_kg: number;
  /** Nullable — non-scale writers send weight alone. */
  body_fat_pct: number | null;
  /** Writer package id (Health Connect data origin) or 'manual'. */
  source: string;
  created_at: Date;
}

export interface NewWeighIn {
  ulid: string;
  occurred_at: Date;
  tz_offset_minutes: number;
  weight_kg: number;
  body_fat_pct?: number | null;
  source: string;
}

export interface WeighInStore {
  /** Idempotent on ulid (Health Connect re-reads replay safely). */
  insertIfAbsent(row: NewWeighIn): Promise<{ record: WeighInRecord; created: boolean }>;
  list(filter: { since?: Date; until?: Date; limit?: number }): Promise<WeighInRecord[]>;
  delete(ulid: string): Promise<boolean>;
}

function rowToWeighIn(row: Record<string, unknown>): WeighInRecord {
  return {
    ulid: row.ulid as string,
    occurred_at: row.occurred_at as Date,
    tz_offset_minutes: Number(row.tz_offset_minutes),
    weight_kg: Number(row.weight_kg),
    body_fat_pct: row.body_fat_pct == null ? null : Number(row.body_fat_pct),
    source: row.source as string,
    created_at: row.created_at as Date,
  };
}

export class PgWeighInStore implements WeighInStore {
  constructor(private sql: postgres.Sql) {}

  async insertIfAbsent(row: NewWeighIn): Promise<{ record: WeighInRecord; created: boolean }> {
    const inserted = await this.sql`
      INSERT INTO kitchen.weigh_ins (ulid, occurred_at, tz_offset_minutes, weight_kg, body_fat_pct, source)
      VALUES (${row.ulid}, ${row.occurred_at}, ${row.tz_offset_minutes},
              ${row.weight_kg}, ${row.body_fat_pct ?? null}, ${row.source})
      ON CONFLICT (ulid) DO NOTHING
      RETURNING *
    `;
    if (inserted.length > 0) return { record: rowToWeighIn(inserted[0]!), created: true };
    const [existing] = await this.sql`SELECT * FROM kitchen.weigh_ins WHERE ulid = ${row.ulid}`;
    if (!existing) throw new Error(`Weigh-in ${row.ulid} conflicted on insert but is not readable`);
    return { record: rowToWeighIn(existing), created: false };
  }

  async list(filter: { since?: Date; until?: Date; limit?: number }): Promise<WeighInRecord[]> {
    // Cap is 2000 (vs the expenditure store's 500): the weight derivation
    // reads a whole window of raw rows — a year of several-readings-a-day
    // mornings still fits.
    const limit = Math.min(filter.limit ?? 100, 2000);
    const since = filter.since ?? new Date(0);
    const until = filter.until ?? new Date('9999-01-01');
    const rows = await this.sql`
      SELECT * FROM kitchen.weigh_ins
      WHERE occurred_at >= ${since} AND occurred_at < ${until}
      ORDER BY occurred_at DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToWeighIn);
  }

  async delete(ulid: string): Promise<boolean> {
    const result = await this.sql`DELETE FROM kitchen.weigh_ins WHERE ulid = ${ulid} RETURNING ulid`;
    return result.length > 0;
  }
}
