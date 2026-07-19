-- Kitchen Module: Receipt-parse quality (phase 2)
--
-- Two additive columns from live-fire feedback after the first real receipt
-- scans (see specs/modules/kitchen.md § Store extraction & precedence,
-- § Conservative non-food skip, POST /receipts, Data model):
--
--   1. purchase_batches.store_undetermined — records that a completed parse
--      found no store from EITHER the scan meta or the header extraction, so a
--      null store is a visible recorded gap rather than a silent one (the
--      lexicon is keyed on store; a null store learns nothing).
--   2. purchase_batch_lines.quantity — the physical-unit count a line
--      represents. A multi-quantity/multibuy line records N here and the parse
--      fans out to N inventory items (one lifecycle each).
--
-- Both are additive with safe defaults, so existing rows are unaffected and the
-- file is transaction-safe under the migration runner. Instance-agnostic empty
-- schema — no seed content.

ALTER TABLE kitchen.purchase_batches
    ADD COLUMN store_undetermined BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE kitchen.purchase_batch_lines
    ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1
        CHECK (quantity >= 1);
