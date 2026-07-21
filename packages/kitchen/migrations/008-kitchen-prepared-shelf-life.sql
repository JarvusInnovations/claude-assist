-- Kitchen Module: `prepared` shelf-life class
--
-- Adds a shelf-life class for cooked/assembled dishes — the output of a
-- `convert` (overnight-oats jars, hard-boiled eggs, cooked grains). See
-- specs/modules/kitchen.md § Data model § Shelf-life classes and § Conversions.
--
-- A `prepared` item is good ~4 days from its MAKE date and, unlike the grocery
-- classes, does not get a fresh window when opened (the day windows live in
-- code, `src/inventory-derive.ts` SHELF_LIFE_WINDOWS + deriveEatBy's make-date
-- anchoring). `convert` defaults its derived item to this class so a prepped
-- dish always earns an eat-by instead of falling to `unknown`.
--
-- Purely additive: adds one enum value, touches no existing rows. `ADD VALUE`
-- runs inside the migration runner's per-file transaction on PostgreSQL 12+
-- because the new value is not USED in this same transaction; `IF NOT EXISTS`
-- makes re-application a no-op.

ALTER TYPE kitchen.shelf_life_class ADD VALUE IF NOT EXISTS 'prepared';
