/**
 * Cross-table atomic write for "consume from inventory" (claude-assist#110,
 * specs/modules/kitchen.md § Consume from inventory): ONE transaction that
 * both (a) idempotently inserts a consumption entry carrying pre-known
 * macros and (b) depletes the source inventory item. A failure of either
 * side must leave NEITHER applied — this is the hard requirement the plan
 * calls out, and it is deliberately NOT built by composing
 * `EntryStore.insertIfAbsent` + `InventoryStore.updateItemState` as two
 * separate calls (that gap — three separate writes with no shared
 * transaction — was flagged in `convert`'s review, claude-assist#116).
 *
 * `kitchen.entries` and `kitchen.inventory_items` are each owned by their
 * own store interface (EntryStore / InventoryStore) for testability and
 * encapsulation, but both live in the same `kitchen` schema behind the same
 * connection pool, so a single transaction can span them safely. This is the
 * ONE write path in the module that deliberately crosses that boundary, and
 * it exists only for this atomicity requirement — everywhere else, entries
 * and inventory stay decoupled through their own interfaces.
 */

import type postgres from 'postgres';
import type { EntryRecord, EstimationSource, NutritionFields } from '../types.js';
import { rowToEntry } from '../store.js';
import type { InventoryItemRecord } from '../inventory-types.js';
import type { ItemStateUpdate } from '../inventory-store.js';
import { rowToItem } from '../inventory-store.js';

/** The consumption entry row to idempotently insert (ulid is the idempotency key). */
export interface ConsumeEntryWrite {
  ulid: string;
  logged_at: Date;
  label: string | null;
  nutrition: NutritionFields;
  source: EstimationSource;
  status: 'estimated';
  /** The inventory item this entry depletes — linked in the SAME insert, not a follow-up UPDATE. */
  inventory_item_ulid: string;
}

export interface ConsumeWriteResult {
  entry: EntryRecord;
  item: InventoryItemRecord;
  /** False on an idempotent replay — neither table was touched by this call. */
  created: boolean;
}

export interface ConsumeStore {
  /**
   * Atomically insert `entry` (idempotent on `entry.ulid`) and, only when
   * the insert actually happened, apply `itemUpdate` to `itemUlid`. Both
   * writes commit together or neither does. A replay (the entry already
   * exists) is a pure read — it returns the existing entry and the item
   * UNCHANGED, never re-applying `itemUpdate`.
   */
  consume(entry: ConsumeEntryWrite, itemUlid: string, itemUpdate: ItemStateUpdate): Promise<ConsumeWriteResult>;

  /**
   * Cheap idempotency pre-check: does an entry with this ULID already
   * exist? Used by the pipeline to short-circuit a replay BEFORE running
   * eligibility/terminal-state validation against the (possibly by-now
   * terminal, e.g. a fraction item the first attempt already finished)
   * current item — a replay must succeed even when the first attempt's
   * depletion already drove the item terminal.
   */
  peekEntry(entryUlid: string): Promise<EntryRecord | null>;
}

export class PgConsumeStore implements ConsumeStore {
  constructor(private sql: postgres.Sql) {}

  async peekEntry(entryUlid: string): Promise<EntryRecord | null> {
    const [row] = await this.sql`SELECT * FROM kitchen.entries WHERE ulid = ${entryUlid}`;
    return row ? rowToEntry(row) : null;
  }

  async consume(
    entry: ConsumeEntryWrite,
    itemUlid: string,
    itemUpdate: ItemStateUpdate
  ): Promise<ConsumeWriteResult> {
    return this.sql.begin(async (rawTx) => {
      // postgres.js's TransactionSql type drops the tagged-template call
      // signature (a TS/Omit limitation) even though it's present at
      // runtime — same cast packages/pages/src/store.ts uses for its own
      // `sql.begin` transaction.
      const tx = rawTx as unknown as postgres.Sql;

      const inserted = await tx`
        INSERT INTO kitchen.entries
          (ulid, logged_at, label, calories, protein_g, fat_g, sat_fat_g, carbs_g, sugar_g,
           fiber_g, sodium_mg, confidence, portion_basis, source, status, inventory_item_ulid)
        VALUES (
          ${entry.ulid}, ${entry.logged_at}, ${entry.label},
          ${entry.nutrition.calories}, ${entry.nutrition.protein_g}, ${entry.nutrition.fat_g},
          ${entry.nutrition.sat_fat_g}, ${entry.nutrition.carbs_g}, ${entry.nutrition.sugar_g},
          ${entry.nutrition.fiber_g}, ${entry.nutrition.sodium_mg},
          ${entry.nutrition.confidence}, ${entry.nutrition.portion_basis},
          ${entry.source}, ${entry.status}, ${entry.inventory_item_ulid}
        )
        ON CONFLICT (ulid) DO NOTHING
        RETURNING *
      `;

      if (inserted.length === 0) {
        // Replay: the entry already exists (a concurrent/retried call won
        // the insert). Read both rows back UNCHANGED — no second deplete.
        const [existingEntry] = await tx`SELECT * FROM kitchen.entries WHERE ulid = ${entry.ulid}`;
        const [currentItem] = await tx`SELECT * FROM kitchen.inventory_items WHERE ulid = ${itemUlid}`;
        if (!existingEntry || !currentItem) {
          throw new Error(`consume: replay lookup failed for entry ${entry.ulid} / item ${itemUlid}`);
        }
        return { entry: rowToEntry(existingEntry), item: rowToItem(currentItem), created: false };
      }

      const [current] = await tx`SELECT * FROM kitchen.inventory_items WHERE ulid = ${itemUlid}`;
      if (!current) {
        throw new Error(`consume: inventory item ${itemUlid} not found mid-transaction`);
      }
      const [updatedItem] = await tx`
        UPDATE kitchen.inventory_items SET
          state = ${itemUpdate.state},
          opened_at = ${itemUpdate.opened_at !== undefined ? itemUpdate.opened_at : (current.opened_at as Date | null)},
          closed_at = ${itemUpdate.closed_at !== undefined ? itemUpdate.closed_at : (current.closed_at as Date | null)},
          on_hand_fraction = ${itemUpdate.on_hand_fraction ?? (current.on_hand_fraction as number)},
          units_remaining = ${itemUpdate.units_remaining !== undefined ? itemUpdate.units_remaining : (current.units_remaining as number | null)},
          eat_by = ${itemUpdate.eat_by !== undefined ? itemUpdate.eat_by : (current.eat_by as Date | null)}
        WHERE ulid = ${itemUlid}
        RETURNING *
      `;
      if (!updatedItem) {
        throw new Error(`consume: failed to update inventory item ${itemUlid}`);
      }
      return { entry: rowToEntry(inserted[0]!), item: rowToItem(updatedItem), created: true };
    });
  }
}
