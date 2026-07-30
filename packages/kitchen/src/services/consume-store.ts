/**
 * Cross-table atomic writes that both touch `kitchen.entries` AND
 * `kitchen.inventory_items` in ONE transaction:
 *
 * - `consume()` — "consume from inventory" (claude-assist#110,
 *   specs/modules/kitchen.md § Consume from inventory): idempotently INSERTS
 *   a consumption entry carrying pre-known macros and depletes the source
 *   item.
 * - `linkConsumption()` — "stated-weight consumption" (specs/modules/
 *   kitchen.md § Stated-weight consumption): LINKS an already-logged entry
 *   (`kitchen.entries.inventory_item_ulid`) to the item it depleted and
 *   applies the depletion, without creating the entry.
 *
 * Both exist because a failure of either side must leave NEITHER applied —
 * the hard requirement is the same one, restated for a second write shape.
 * Neither is built by composing `EntryStore` + `InventoryStore` calls as two
 * separate writes (that gap — separate writes with no shared transaction — was
 * flagged in `convert`'s review, claude-assist#116, and later closed there too:
 * see `InventoryStore.applyConversion`, claude-assist#156. Every multi-write
 * inventory event now holds the guarantee by this same mechanism).
 *
 * `kitchen.entries` and `kitchen.inventory_items` are each owned by their
 * own store interface (EntryStore / InventoryStore) for testability and
 * encapsulation, but both live in the same `kitchen` schema behind the same
 * connection pool, so a single transaction can span them safely. This file is
 * the ONLY place in the module that deliberately crosses that boundary, and
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

/** Result of `linkConsumption` — the stated-weight-consumption atomic write. */
export interface LinkConsumptionResult {
  entry: EntryRecord;
  item: InventoryItemRecord;
  /**
   * False when the entry was ALREADY linked to `itemUlid` — a pure replay,
   * neither side re-applied.
   */
  linked: boolean;
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

  /**
   * The stated-weight-consumption atomic write (specs/modules/kitchen.md
   * § Stated-weight consumption): link an ALREADY-EXISTING entry
   * (`entryUlid`, journaled separately by the caller — this never inserts
   * one) to `itemUlid` and apply `itemUpdate`, in ONE transaction. Both
   * writes commit together or neither does.
   *
   * Idempotent on `entryUlid`: when the entry is already linked to
   * `itemUlid`, this is a pure read (`linked: false`) that reapplies
   * neither write. The pipeline is expected to have already ruled out the
   * conflicting case (the entry linked to a DIFFERENT item) and the missing
   * case (no such entry) before calling this — see
   * `InventoryPipeline.consumeStatedAmount` — so those are should-never-
   * happen races here, surfaced as a plain `Error`, not a typed one.
   */
  linkConsumption(entryUlid: string, itemUlid: string, itemUpdate: ItemStateUpdate): Promise<LinkConsumptionResult>;
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
           added_sugar_g, fiber_g, sodium_mg, confidence, portion_basis, source, status,
           inventory_item_ulid)
        VALUES (
          ${entry.ulid}, ${entry.logged_at}, ${entry.label},
          ${entry.nutrition.calories}, ${entry.nutrition.protein_g}, ${entry.nutrition.fat_g},
          ${entry.nutrition.sat_fat_g}, ${entry.nutrition.carbs_g}, ${entry.nutrition.sugar_g},
          ${entry.nutrition.added_sugar_g},
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
          -- A consume only ever depletes: it never sets shelf_life_class,
          -- storage_moved_at, unit_seal, needs_info, or product_ulid, so those
          -- columns are deliberately absent here rather than restated as no-ops.
        WHERE ulid = ${itemUlid}
        RETURNING *
      `;
      if (!updatedItem) {
        throw new Error(`consume: failed to update inventory item ${itemUlid}`);
      }
      return { entry: rowToEntry(inserted[0]!), item: rowToItem(updatedItem), created: true };
    });
  }

  async linkConsumption(
    entryUlid: string,
    itemUlid: string,
    itemUpdate: ItemStateUpdate
  ): Promise<LinkConsumptionResult> {
    return this.sql.begin(async (rawTx) => {
      const tx = rawTx as unknown as postgres.Sql;

      // Lock the entry row for the duration of the transaction so a
      // near-simultaneous replay can't race this read against the UPDATE
      // below (mirrors `consume`'s ON CONFLICT DO NOTHING idempotency net,
      // restated for an UPDATE rather than an INSERT).
      const [entryRow] = await tx`SELECT * FROM kitchen.entries WHERE ulid = ${entryUlid} FOR UPDATE`;
      if (!entryRow) {
        // The pipeline already checked this exists before calling in —
        // reaching here is a should-never-happen race, not a caller error.
        throw new Error(`linkConsumption: entry ${entryUlid} not found mid-transaction`);
      }
      const existingLink = entryRow.inventory_item_ulid as string | null;
      if (existingLink && existingLink !== itemUlid) {
        // Ditto: the pipeline's pre-check should have caught this.
        throw new Error(`linkConsumption: entry ${entryUlid} already linked to a different item (${existingLink})`);
      }

      if (existingLink === itemUlid) {
        // Replay: already linked to THIS item. Read both rows back
        // UNCHANGED — no second deplete.
        const [currentItem] = await tx`SELECT * FROM kitchen.inventory_items WHERE ulid = ${itemUlid}`;
        if (!currentItem) {
          throw new Error(`linkConsumption: replay lookup failed for item ${itemUlid}`);
        }
        return { entry: rowToEntry(entryRow), item: rowToItem(currentItem), linked: false };
      }

      const [current] = await tx`SELECT * FROM kitchen.inventory_items WHERE ulid = ${itemUlid}`;
      if (!current) {
        throw new Error(`linkConsumption: inventory item ${itemUlid} not found mid-transaction`);
      }
      const [linkedEntryRow] = await tx`
        UPDATE kitchen.entries SET inventory_item_ulid = ${itemUlid}
        WHERE ulid = ${entryUlid}
        RETURNING *
      `;
      if (!linkedEntryRow) {
        throw new Error(`linkConsumption: failed to link entry ${entryUlid}`);
      }
      const [updatedItem] = await tx`
        UPDATE kitchen.inventory_items SET
          state = ${itemUpdate.state},
          closed_at = ${itemUpdate.closed_at !== undefined ? itemUpdate.closed_at : (current.closed_at as Date | null)},
          on_hand_fraction = ${itemUpdate.on_hand_fraction ?? (current.on_hand_fraction as number)},
          notes = ${itemUpdate.notes !== undefined ? itemUpdate.notes : (current.notes as string | null)}
          -- Stated-weight consumption only ever depletes a fraction-modeled
          -- item and appends a provenance note: it never touches opened_at,
          -- units_remaining, eat_by, shelf_life_class, storage_moved_at,
          -- unit_seal, needs_info, or product_ulid, so those columns are
          -- deliberately absent here rather than restated as no-ops.
        WHERE ulid = ${itemUlid}
        RETURNING *
      `;
      if (!updatedItem) {
        throw new Error(`linkConsumption: failed to update inventory item ${itemUlid}`);
      }
      return { entry: rowToEntry(linkedEntryRow), item: rowToItem(updatedItem), linked: true };
    });
  }
}
