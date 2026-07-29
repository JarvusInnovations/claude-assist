/**
 * In-memory EntryStore/RecipeStore. Used by the test suite and mirrors
 * PgEntryStore/PgRecipeStore semantics exactly (see capture/src/memory-store.ts
 * for the sibling pattern).
 */

import { normalizeRecipeName } from './types.js';
import type {
  EntryRecord,
  EntryStatus,
  EstimateExclusion,
  EstimationSource,
  NutritionFields,
  RecipeComponent,
  RecipeRecord,
} from './types.js';
import type {
  EntryStore,
  ExpenditureRecord,
  ExpenditureStore,
  NewEntry,
  NewExpenditure,
  NewRecipe,
  NewWeighIn,
  RecentEntrySummary,
  RecipeStore,
  StravaOAuthState,
  StravaOAuthStore,
  WeighInRecord,
  WeighInStore,
} from './store.js';
import { EMPTY_NUTRITION } from './store.js';

export class MemoryEntryStore implements EntryStore {
  readonly records = new Map<string, EntryRecord>();

  async insertIfAbsent(entry: NewEntry): Promise<{ record: EntryRecord; created: boolean }> {
    const existing = this.records.get(entry.ulid);
    if (existing) {
      return { record: structuredClone(existing), created: false };
    }
    const now = new Date();
    const record: EntryRecord = {
      ulid: entry.ulid,
      logged_at: entry.logged_at,
      received_at: now,
      note: entry.note,
      label: null,
      ...EMPTY_NUTRITION,
      source: null,
      status: 'estimating',
      estimate_attempts: 0,
      last_error: null,
      last_error_at: null,
      recipe_ulid: entry.recipe_ulid,
      component_quantities: entry.component_quantities,
      portion_multiplier: 1,
      inventory_item_ulid: null,
      excluded_lines: null,
      created_at: now,
      updated_at: now,
    };
    this.records.set(entry.ulid, record);
    return { record: structuredClone(record), created: true };
  }

  async get(ulid: string): Promise<EntryRecord | null> {
    const record = this.records.get(ulid);
    return record ? structuredClone(record) : null;
  }

  async list(filter: { since?: Date; limit?: number }): Promise<EntryRecord[]> {
    const limit = Math.min(filter.limit ?? 50, 500);
    return [...this.records.values()]
      .filter((r) => !filter.since || r.logged_at.getTime() > filter.since.getTime())
      .sort((a, b) => b.logged_at.getTime() - a.logged_at.getTime())
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async selectForEstimation(limit: number, maxAttempts: number): Promise<EntryRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.status === 'estimating' && r.estimate_attempts < maxAttempts)
      .sort((a, b) => a.logged_at.getTime() - b.logged_at.getTime())
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  private mustGet(ulid: string): EntryRecord {
    const record = this.records.get(ulid);
    if (!record) throw new Error(`Kitchen entry not found: ${ulid}`);
    return record;
  }

  async applyEstimate(
    ulid: string,
    label: string | null,
    nutrition: NutritionFields,
    source: EstimationSource,
    nextStatus: EntryStatus,
    excludedLines?: EstimateExclusion[] | null
  ): Promise<void> {
    const record = this.mustGet(ulid);
    Object.assign(record, nutrition);
    // Mirrors PgEntryStore: an empty report and no report both store null.
    record.excluded_lines = excludedLines && excludedLines.length > 0 ? structuredClone(excludedLines) : null;
    if (label !== null) record.label = label;
    record.source = source;
    record.status = nextStatus;
    record.estimate_attempts = 0;
    record.last_error = null;
    record.last_error_at = null;
  }

  async recordEstimationFailure(ulid: string, error: string): Promise<number> {
    const record = this.mustGet(ulid);
    record.estimate_attempts += 1;
    record.last_error = error;
    record.last_error_at = new Date();
    return record.estimate_attempts;
  }

  async applyEstimateCapped(ulid: string): Promise<void> {
    this.mustGet(ulid).status = 'failed';
  }

  async applyManualOverride(
    ulid: string,
    nutrition: Partial<NutritionFields>,
    extra: { label?: string; note?: string }
  ): Promise<void> {
    const record = this.mustGet(ulid);
    Object.assign(record, nutrition);
    record.confidence = null;
    if (extra.label !== undefined) record.label = extra.label;
    if (extra.note !== undefined) record.note = extra.note;
    record.source = 'manual';
    record.status = 'estimated';
    record.last_error = null;
    record.last_error_at = null;
  }

  async applyRequeue(ulid: string, extra: { label?: string; note?: string }): Promise<void> {
    const record = this.mustGet(ulid);
    if (extra.label !== undefined) record.label = extra.label;
    if (extra.note !== undefined) record.note = extra.note;
    record.status = 'estimating';
    record.estimate_attempts = 0;
    record.last_error = null;
    record.last_error_at = null;
  }

  async applyPortionMultiplier(ulid: string, multiplier: number): Promise<void> {
    this.mustGet(ulid).portion_multiplier = multiplier;
  }

  async applyLoggedAt(ulid: string, loggedAt: Date): Promise<void> {
    this.mustGet(ulid).logged_at = loggedAt;
  }

  async delete(ulid: string): Promise<boolean> {
    return this.records.delete(ulid);
  }

  async linkInventoryItem(entryUlid: string, itemUlid: string): Promise<void> {
    const record = this.records.get(entryUlid);
    if (record) record.inventory_item_ulid = itemUlid;
  }

  async relinkInventoryItem(fromItemUlid: string, toItemUlid: string): Promise<number> {
    let moved = 0;
    for (const record of this.records.values()) {
      if (record.inventory_item_ulid === fromItemUlid) {
        record.inventory_item_ulid = toItemUlid;
        moved++;
      }
    }
    return moved;
  }

  async recentLabels(limit: number): Promise<RecentEntrySummary[]> {
    const byLabel = new Map<string, RecentEntrySummary>();
    const sorted = [...this.records.values()]
      .filter((r) => r.label && r.status === 'estimated')
      .sort((a, b) => b.logged_at.getTime() - a.logged_at.getTime());
    for (const r of sorted) {
      const label = r.label!;
      const existing = byLabel.get(label);
      if (existing) {
        existing.log_count += 1;
      } else {
        byLabel.set(label, {
          // `sorted` is newest-first, so the first row seen for a label is its
          // most-recent estimated occurrence — the entry a recent pill clones.
          entry_ulid: r.ulid,
          label,
          calories: r.calories,
          protein_g: r.protein_g,
          fat_g: r.fat_g,
          sat_fat_g: r.sat_fat_g,
          carbs_g: r.carbs_g,
          sugar_g: r.sugar_g,
          added_sugar_g: r.added_sugar_g,
          fiber_g: r.fiber_g,
          sodium_mg: r.sodium_mg,
          last_logged_at: r.logged_at,
          log_count: 1,
        });
      }
    }
    return [...byLabel.values()]
      .sort((a, b) => b.last_logged_at.getTime() - a.last_logged_at.getTime())
      .slice(0, limit);
  }
}

export class MemoryRecipeStore implements RecipeStore {
  readonly records = new Map<string, RecipeRecord>();

  async insert(recipe: NewRecipe): Promise<RecipeRecord> {
    const now = new Date();
    const record: RecipeRecord = { ...recipe, created_at: now, updated_at: now, archived_at: null };
    this.records.set(recipe.ulid, record);
    return structuredClone(record);
  }

  // Archived rows deliberately included — history must keep resolving.
  async get(ulid: string): Promise<RecipeRecord | null> {
    const record = this.records.get(ulid);
    return record ? structuredClone(record) : null;
  }

  async list(filter: { limit?: number }): Promise<RecipeRecord[]> {
    const limit = filter.limit ?? 100;
    return [...this.records.values()]
      .filter((r) => r.archived_at === null)
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async findLiveByNormalizedName(normalizedName: string): Promise<RecipeRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.archived_at === null && normalizeRecipeName(r.name) === normalizedName)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map((r) => structuredClone(r));
  }

  async replace(
    ulid: string,
    update: { name: string; components: RecipeComponent[] }
  ): Promise<RecipeRecord | null> {
    const record = this.records.get(ulid);
    if (!record) return null;
    // ulid / created_at / source preserved — a correction replaces the record,
    // it does not re-found it.
    const next: RecipeRecord = {
      ...record,
      name: update.name,
      components: structuredClone(update.components),
      updated_at: new Date(),
    };
    this.records.set(ulid, next);
    return structuredClone(next);
  }

  async archive(ulid: string): Promise<RecipeRecord | null> {
    const record = this.records.get(ulid);
    if (!record) return null;
    // Idempotent: an already-archived row keeps its original stamp.
    const next: RecipeRecord = { ...record, archived_at: record.archived_at ?? new Date() };
    this.records.set(ulid, next);
    return structuredClone(next);
  }
}

export class MemoryExpenditureStore implements ExpenditureStore {
  readonly records = new Map<string, ExpenditureRecord>();

  async insertIfAbsent(row: NewExpenditure): Promise<{ record: ExpenditureRecord; created: boolean }> {
    const existing = this.records.get(row.ulid);
    if (existing) return { record: structuredClone(existing), created: false };
    const now = new Date();
    const record: ExpenditureRecord = {
      ulid: row.ulid,
      occurred_at: row.occurred_at,
      source: row.source,
      label: row.label,
      kcal: row.kcal,
      duration_min: row.duration_min ?? null,
      avg_hr: row.avg_hr ?? null,
      created_at: now,
      updated_at: now,
    };
    this.records.set(row.ulid, record);
    return { record: structuredClone(record), created: true };
  }

  async list(filter: { since?: Date; until?: Date; limit?: number }): Promise<ExpenditureRecord[]> {
    const since = filter.since?.getTime() ?? 0;
    const until = filter.until?.getTime() ?? Infinity;
    return [...this.records.values()]
      .filter((r) => r.occurred_at.getTime() >= since && r.occurred_at.getTime() < until)
      .sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime())
      .slice(0, Math.min(filter.limit ?? 100, 500))
      .map((r) => structuredClone(r));
  }

  async delete(ulid: string): Promise<boolean> {
    return this.records.delete(ulid);
  }

  async existingUlids(ulids: string[]): Promise<Set<string>> {
    return new Set(ulids.filter((ulid) => this.records.has(ulid)));
  }
}

export class MemoryStravaOAuthStore implements StravaOAuthStore {
  state: StravaOAuthState | null = null;

  async get(): Promise<StravaOAuthState | null> {
    return this.state ? { ...this.state } : null;
  }

  async seed(refreshToken: string): Promise<StravaOAuthState> {
    if (!this.state) {
      this.state = {
        refresh_token: refreshToken,
        access_token: null,
        expires_at: null,
        updated_at: new Date(),
      };
    }
    return { ...this.state };
  }

  async save(state: { refresh_token: string; access_token: string | null; expires_at: Date | null }): Promise<void> {
    this.state = { ...state, updated_at: new Date() };
  }
}

export class MemoryWeighInStore implements WeighInStore {
  readonly records = new Map<string, WeighInRecord>();

  async insertIfAbsent(row: NewWeighIn): Promise<{ record: WeighInRecord; created: boolean }> {
    const existing = this.records.get(row.ulid);
    if (existing) return { record: structuredClone(existing), created: false };
    const record: WeighInRecord = {
      ulid: row.ulid,
      occurred_at: row.occurred_at,
      tz_offset_minutes: row.tz_offset_minutes,
      weight_kg: row.weight_kg,
      body_fat_pct: row.body_fat_pct ?? null,
      source: row.source,
      created_at: new Date(),
    };
    this.records.set(row.ulid, record);
    return { record: structuredClone(record), created: true };
  }

  async list(filter: { since?: Date; until?: Date; limit?: number }): Promise<WeighInRecord[]> {
    const since = filter.since?.getTime() ?? 0;
    const until = filter.until?.getTime() ?? Infinity;
    return [...this.records.values()]
      .filter((r) => r.occurred_at.getTime() >= since && r.occurred_at.getTime() < until)
      .sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime())
      .slice(0, Math.min(filter.limit ?? 100, 2000))
      .map((r) => structuredClone(r));
  }

  async delete(ulid: string): Promise<boolean> {
    return this.records.delete(ulid);
  }
}
