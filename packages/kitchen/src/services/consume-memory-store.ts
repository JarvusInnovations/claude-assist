/**
 * In-memory ConsumeStore. Mirrors PgConsumeStore's semantics — idempotent on
 * `entry.ulid`, all-or-nothing on the (entry insert, item deplete) pair —
 * without a real database transaction: both writes are applied to the
 * underlying maps, and any error before both have landed is rolled back on
 * BOTH sides before rethrowing. See services/consume-store.ts for the full
 * rationale (claude-assist#110).
 */

import type { EntryRecord } from '../types.js';
import type { InventoryItemRecord } from '../inventory-types.js';
import type { ItemStateUpdate } from '../inventory-store.js';
import type { ConsumeEntryWrite, ConsumeStore, ConsumeWriteResult, LinkConsumptionResult } from './consume-store.js';
import type { MemoryEntryStore } from '../memory-store.js';
import type { MemoryInventoryStore } from '../inventory-memory-store.js';

export interface MemoryConsumeStoreTestHooks {
  /**
   * Test-only fault injection: invoked after the entry write lands but
   * BEFORE the item write is applied, inside the same try/catch that rolls
   * both sides back on any throw. Exists so tests can prove atomicity by
   * forcing a mid-operation failure with otherwise-valid input — never set
   * in production wiring. Shared by `consume()` (entry INSERT) and
   * `linkConsumption()` (entry LINK) — both call it at the same structural
   * point, between their first write and their second.
   */
  beforeItemWrite?: () => void;
}

export class MemoryConsumeStore implements ConsumeStore {
  constructor(
    private entryStore: MemoryEntryStore,
    private itemStore: MemoryInventoryStore,
    private hooks: MemoryConsumeStoreTestHooks = {}
  ) {}

  async peekEntry(entryUlid: string): Promise<EntryRecord | null> {
    const existing = this.entryStore.records.get(entryUlid);
    return existing ? structuredClone(existing) : null;
  }

  async consume(
    entry: ConsumeEntryWrite,
    itemUlid: string,
    itemUpdate: ItemStateUpdate
  ): Promise<ConsumeWriteResult> {
    const existingEntry = this.entryStore.records.get(entry.ulid);
    if (existingEntry) {
      const currentItem = this.itemStore.items.get(itemUlid);
      if (!currentItem) throw new Error(`consume: inventory item ${itemUlid} not found`);
      return { entry: structuredClone(existingEntry), item: structuredClone(currentItem), created: false };
    }

    const itemBefore = this.itemStore.items.get(itemUlid);
    if (!itemBefore) throw new Error(`consume: inventory item ${itemUlid} not found`);
    const itemBeforeSnapshot = structuredClone(itemBefore);

    const now = new Date();
    const entryRecord: EntryRecord = {
      ulid: entry.ulid,
      logged_at: entry.logged_at,
      received_at: now,
      note: null,
      // A one-tap consume writes no note at all, so there is nothing for a
      // human to have said and nothing to review.
      notes_reviewed: true,
      label: entry.label,
      calories: entry.nutrition.calories,
      protein_g: entry.nutrition.protein_g,
      fat_g: entry.nutrition.fat_g,
      sat_fat_g: entry.nutrition.sat_fat_g,
      carbs_g: entry.nutrition.carbs_g,
      sugar_g: entry.nutrition.sugar_g,
      added_sugar_g: entry.nutrition.added_sugar_g,
      fiber_g: entry.nutrition.fiber_g,
      sodium_mg: entry.nutrition.sodium_mg,
      confidence: entry.nutrition.confidence,
      portion_basis: entry.nutrition.portion_basis,
      source: entry.source,
      status: entry.status,
      estimate_attempts: 0,
      last_error: null,
      last_error_at: null,
      recipe_ulid: null,
      component_quantities: null,
      excluded_lines: null,
      portion_multiplier: 1,
      inventory_item_ulid: entry.inventory_item_ulid,
      created_at: now,
      updated_at: now,
    };

    // Write side 1 (entry). Rolled back in the catch below if anything
    // between here and the item write throws — including the test-only
    // `beforeItemWrite` fault-injection hook.
    this.entryStore.records.set(entry.ulid, entryRecord);
    try {
      this.hooks.beforeItemWrite?.();

      const updatedItem: InventoryItemRecord = {
        ...itemBeforeSnapshot,
        state: itemUpdate.state,
        opened_at: itemUpdate.opened_at !== undefined ? itemUpdate.opened_at : itemBeforeSnapshot.opened_at,
        closed_at: itemUpdate.closed_at !== undefined ? itemUpdate.closed_at : itemBeforeSnapshot.closed_at,
        on_hand_fraction: itemUpdate.on_hand_fraction ?? itemBeforeSnapshot.on_hand_fraction,
        units_remaining:
          itemUpdate.units_remaining !== undefined ? itemUpdate.units_remaining : itemBeforeSnapshot.units_remaining,
        eat_by: itemUpdate.eat_by !== undefined ? itemUpdate.eat_by : itemBeforeSnapshot.eat_by,
        updated_at: now,
      };
      // Write side 2 (item).
      this.itemStore.items.set(itemUlid, updatedItem);

      return { entry: structuredClone(entryRecord), item: structuredClone(updatedItem), created: true };
    } catch (err) {
      // Roll back BOTH sides — a failure here must leave neither applied.
      this.entryStore.records.delete(entry.ulid);
      this.itemStore.items.set(itemUlid, itemBeforeSnapshot);
      throw err;
    }
  }

  async linkConsumption(
    entryUlid: string,
    itemUlid: string,
    itemUpdate: ItemStateUpdate
  ): Promise<LinkConsumptionResult> {
    const entryBefore = this.entryStore.records.get(entryUlid);
    if (!entryBefore) {
      // The pipeline already checked this exists before calling in —
      // reaching here is a should-never-happen race, not a caller error.
      throw new Error(`linkConsumption: entry ${entryUlid} not found`);
    }
    if (entryBefore.inventory_item_ulid && entryBefore.inventory_item_ulid !== itemUlid) {
      throw new Error(`linkConsumption: entry ${entryUlid} already linked to a different item (${entryBefore.inventory_item_ulid})`);
    }

    if (entryBefore.inventory_item_ulid === itemUlid) {
      // Replay: already linked to THIS item. Neither side is re-applied.
      const currentItem = this.itemStore.items.get(itemUlid);
      if (!currentItem) throw new Error(`linkConsumption: item ${itemUlid} not found`);
      return { entry: structuredClone(entryBefore), item: structuredClone(currentItem), linked: false };
    }

    const itemBefore = this.itemStore.items.get(itemUlid);
    if (!itemBefore) throw new Error(`linkConsumption: item ${itemUlid} not found`);
    const itemBeforeSnapshot = structuredClone(itemBefore);
    const entryBeforeSnapshot = structuredClone(entryBefore);
    const now = new Date();

    // Write side 1 (link). Rolled back in the catch below if anything
    // between here and the item write throws — including the test-only
    // `beforeItemWrite` fault-injection hook (shared with `consume()`).
    const linkedEntry: EntryRecord = { ...entryBeforeSnapshot, inventory_item_ulid: itemUlid, updated_at: now };
    this.entryStore.records.set(entryUlid, linkedEntry);
    try {
      this.hooks.beforeItemWrite?.();

      const updatedItem: InventoryItemRecord = {
        ...itemBeforeSnapshot,
        state: itemUpdate.state,
        closed_at: itemUpdate.closed_at !== undefined ? itemUpdate.closed_at : itemBeforeSnapshot.closed_at,
        on_hand_fraction: itemUpdate.on_hand_fraction ?? itemBeforeSnapshot.on_hand_fraction,
        notes: itemUpdate.notes !== undefined ? itemUpdate.notes : itemBeforeSnapshot.notes,
        updated_at: now,
      };
      // Write side 2 (item).
      this.itemStore.items.set(itemUlid, updatedItem);

      return { entry: structuredClone(linkedEntry), item: structuredClone(updatedItem), linked: true };
    } catch (err) {
      // Roll back BOTH sides — a failure here must leave neither applied.
      this.entryStore.records.set(entryUlid, entryBeforeSnapshot);
      this.itemStore.items.set(itemUlid, itemBeforeSnapshot);
      throw err;
    }
  }
}
