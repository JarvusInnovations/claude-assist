-- Kitchen Module: Needs-info flow (dismissal + non-inventory markers)
--
-- Three related additions on top of 002-kitchen-inventory.sql, from live-fire
-- feedback after the first real receipt scan. See specs/modules/kitchen.md
-- (§ Non-inventory dismissal, § Inventory state machine, GET /inventory/questions,
-- POST /inventory/:ulid/label, POST /inventory/:ulid/dismiss):
--
--   1. A terminal `dismissed` inventory state — removes a non-grocery line
--      (housewares etc.) WITHOUT the food-waste semantics of `tossed`.
--   2. A `skipped` batch-line outcome — a parsed line the parser honored a
--      non-inventory lexicon marker for (no item created, line retained).
--   3. Non-inventory lexicon markers — a receipt_lexicon row with a null
--      product and `non_inventory = true` that future parses skip.
--
-- New enum VALUEs are added but never referenced within this migration's
-- transaction (PG only forbids USING a freshly added value in the same tx, not
-- adding it), so the whole file remains transaction-safe under the migration
-- runner. Instance-agnostic empty schema — no seed content.

-- 1. Terminal dismissal state for the inventory lifecycle.
ALTER TYPE kitchen.inventory_state ADD VALUE IF NOT EXISTS 'dismissed';

-- 2. Skipped outcome for a batch line that hit a non-inventory marker.
ALTER TYPE kitchen.line_match_outcome ADD VALUE IF NOT EXISTS 'skipped';

-- 3. Non-inventory markers in the receipt lexicon.
--    A skip marker has a null product, so product_ulid becomes nullable. The
--    inline regex CHECK already passes on NULL (NULL ~ '…' is NULL, not FALSE),
--    so only the NOT NULL needs dropping.
ALTER TABLE kitchen.receipt_lexicon
    ALTER COLUMN product_ulid DROP NOT NULL;

ALTER TABLE kitchen.receipt_lexicon
    ADD COLUMN non_inventory BOOLEAN NOT NULL DEFAULT FALSE;
