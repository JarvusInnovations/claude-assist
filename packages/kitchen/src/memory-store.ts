/**
 * In-memory EntryStore/RecipeStore. Used by the test suite and mirrors
 * PgEntryStore/PgRecipeStore semantics exactly (see capture/src/memory-store.ts
 * for the sibling pattern).
 */

import type { EntryRecord, EntryStatus, EstimationSource, NutritionFields, RecipeRecord } from './types.js';
import type {
  EntryStore,
  NewEntry,
  NewRecipe,
  RecentEntrySummary,
  RecipeStore,
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
    nextStatus: EntryStatus
  ): Promise<void> {
    const record = this.mustGet(ulid);
    Object.assign(record, nutrition);
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

  async delete(ulid: string): Promise<boolean> {
    return this.records.delete(ulid);
  }

  async linkInventoryItem(entryUlid: string, itemUlid: string): Promise<void> {
    const record = this.records.get(entryUlid);
    if (record) record.inventory_item_ulid = itemUlid;
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
          label,
          calories: r.calories,
          protein_g: r.protein_g,
          fat_g: r.fat_g,
          sat_fat_g: r.sat_fat_g,
          carbs_g: r.carbs_g,
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
    const record: RecipeRecord = { ...recipe, created_at: now, updated_at: now };
    this.records.set(recipe.ulid, record);
    return structuredClone(record);
  }

  async get(ulid: string): Promise<RecipeRecord | null> {
    const record = this.records.get(ulid);
    return record ? structuredClone(record) : null;
  }

  async list(filter: { limit?: number }): Promise<RecipeRecord[]> {
    const limit = filter.limit ?? 100;
    return [...this.records.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
}
