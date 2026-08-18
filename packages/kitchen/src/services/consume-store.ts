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
 *   (a `kitchen.entry_consumptions` row, keyed on the `(entry, item)` PAIR) to
 *   the item it depleted and applies the depletion, without creating the entry.
 *   One entry may link to many items — a meal depletes one per tracked
 *   component.
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
import type {
  ConsumptionAmount,
  EntryConsumptionRecord,
  EntryRecord,
  EstimationSource,
  NutritionFields,
} from '../types.js';
import { rowToEntry, rowToEntryConsumption } from '../store.js';
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
  /**
   * The inventory item this entry depletes — set in the SAME insert, not a
   * follow-up UPDATE. This is the DERIVED column (specs/modules/kitchen.md
   * § Data model); the authoritative `kitchen.entry_consumptions` row is
   * written in the same transaction.
   */
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
   * False when this exact `(entry, item)` PAIR was already recorded — a pure
   * replay, neither side re-applied. The same entry against a DIFFERENT item is
   * the next component of the same meal and links normally.
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
  consume(
    entry: ConsumeEntryWrite,
    itemUlid: string,
    itemUpdate: ItemStateUpdate,
    applied: ConsumptionAmount
  ): Promise<ConsumeWriteResult>;

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
   * The per-PAIR replay pre-check (specs/modules/kitchen.md § Stated-weight
   * consumption): has THIS entry already depleted THIS item? Non-null means a
   * replay; null means either a first link or the next component of a
   * multi-component meal, which are the same thing to this table.
   *
   * Split from `peekEntry` because the two questions are genuinely different
   * now: one asks whether the entry exists at all, the other whether this pair
   * has already been applied. Reading the answer to the second off the entry's
   * single link column is the defect this table replaced — it made every
   * component after the first look like a conflict with the first.
   */
  peekConsumption(entryUlid: string, itemUlid: string): Promise<EntryConsumptionRecord | null>;

  /**
   * The stated-weight-consumption atomic write (specs/modules/kitchen.md
   * § Stated-weight consumption): link an ALREADY-EXISTING entry
   * (`entryUlid`, journaled separately by the caller — this never inserts
   * one) to `itemUlid` and apply `itemUpdate`, in ONE transaction. Both
   * writes commit together or neither does.
   *
   * Idempotent on the PAIR `(entryUlid, itemUlid)`: when that pair is already
   * recorded, this is a pure read (`linked: false`) that reapplies neither
   * write. A different `itemUlid` under the same entry is NOT a conflict — a
   * meal depletes one item per tracked component, and refusing the second was
   * the defect this keying fixes (claude-assist#215). The pipeline is expected
   * to have already ruled out the missing case (no such entry) before calling
   * this — see `InventoryPipeline.consumeStatedAmount` — so that is a
   * should-never-happen race here, surfaced as a plain `Error`, not a typed one.
   */
  linkConsumption(
    entryUlid: string,
    itemUlid: string,
    itemUpdate: ItemStateUpdate,
    applied: ConsumptionAmount
  ): Promise<LinkConsumptionResult>;
}

export class PgConsumeStore implements ConsumeStore {
  constructor(private sql: postgres.Sql) {}

  async peekEntry(entryUlid: string): Promise<EntryRecord | null> {
    const [row] = await this.sql`SELECT * FROM kitchen.entries WHERE ulid = ${entryUlid}`;
    return row ? rowToEntry(row) : null;
  }

  async peekConsumption(entryUlid: string, itemUlid: string): Promise<EntryConsumptionRecord | null> {
    const [row] = await this.sql`
      SELECT * FROM kitchen.entry_consumptions
      WHERE entry_ulid = ${entryUlid} AND item_ulid = ${itemUlid}
    `;
    return row ? rowToEntryConsumption(row) : null;
  }

  async consume(
    entry: ConsumeEntryWrite,
    itemUlid: string,
    itemUpdate: ItemStateUpdate,
    applied: ConsumptionAmount
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

      // The authoritative link, in the same transaction as the entry that just
      // won the insert — so there is no window where the entry exists and its
      // depletion claim does not.
      await tx`
        INSERT INTO kitchen.entry_consumptions (entry_ulid, item_ulid, amount, amount_kind)
        VALUES (${entry.ulid}, ${itemUlid}, ${applied.amount}, ${applied.amount_kind})
        ON CONFLICT (entry_ulid, item_ulid) DO NOTHING
      `;

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
    itemUpdate: ItemStateUpdate,
    applied: ConsumptionAmount
  ): Promise<LinkConsumptionResult> {
    return this.sql.begin(async (rawTx) => {
      const tx = rawTx as unknown as postgres.Sql;

      // Lock the entry row for the duration of the transaction: it proves the
      // entry exists, and it serialises the read-modify-write on the derived
      // `inventory_item_ulid` column below when several components of ONE meal
      // land at once. The real replay guard is the pair-keyed INSERT that
      // follows (mirroring `consume`'s ON CONFLICT DO NOTHING net).
      const [entryRow] = await tx`SELECT * FROM kitchen.entries WHERE ulid = ${entryUlid} FOR UPDATE`;
      if (!entryRow) {
        // The pipeline already checked this exists before calling in —
        // reaching here is a should-never-happen race, not a caller error.
        throw new Error(`linkConsumption: entry ${entryUlid} not found mid-transaction`);
      }

      // Idempotency is the PAIR. Zero rows back means this entry already
      // depleted this item; a different item under the same entry inserts
      // cleanly, because that is the next component, not a conflict.
      const claimed = await tx`
        INSERT INTO kitchen.entry_consumptions (entry_ulid, item_ulid, amount, amount_kind)
        VALUES (${entryUlid}, ${itemUlid}, ${applied.amount}, ${applied.amount_kind})
        ON CONFLICT (entry_ulid, item_ulid) DO NOTHING
        RETURNING entry_ulid
      `;

      if (claimed.length === 0) {
        // Replay of this exact pair. Read both rows back UNCHANGED — no
        // second deplete.
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
      // The derived column takes the FIRST item only — a second component must
      // not slide it forward (specs/modules/kitchen.md § Data model).
      const [linkedEntryRow] = await tx`
        UPDATE kitchen.entries
        SET inventory_item_ulid = COALESCE(inventory_item_ulid, ${itemUlid})
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
