-- Kitchen Module: storage moves + what a counted package seals
-- (specs/modules/kitchen.md § Storage moves, § count-vs-fraction).
--
-- Two additive columns, both from the same defect: an item's state could not
-- express what was physically the case, so the ledger asserted something false
-- rather than merely losing detail.
--
--   1. storage_moved_at — a shelf-life class is a claim about WHERE food lives,
--      and food moves between appliances. The eat-by derivation assumed it never
--      does, so a sealed pack thawed on day 8 resumed a fridge clock as though it
--      had never been frozen. Both directions of the resulting mis-record
--      mislead, oppositely: recorded as a fridge class while actually frozen, an
--      item ages on paper while sitting safe (and over a long freeze reads
--      expired); recorded as frozen while actually thawed days ago, it reads
--      indefinitely safe while running a ~1-week fuse. The second is the
--      dangerous one, and preventing it is the whole job. This column is the date
--      of the most recent recorded move, and from then on the clock's ANCHOR: the
--      derivation takes the latest of opened_at/acquired_at and this, so a move
--      restarts the window from the move rather than resuming the old one. Only
--      the latest move is retained — only current storage governs the current
--      clock — and the full transition history lives in the item's notes.
--
--   2. unit_seal — counting and being openable are independent axes, not
--      alternatives. A can 3-pack seals each unit separately, so opening one
--      leaves the rest shelf-stable at the unopened window (the behavior the
--      count model shipped with). A 4-link vacuum pack, a sliced loaf, an egg
--      carton, or a tray of prepped portions is ONE seal over N discrete units:
--      opening the container puts the WHOLE remainder on the opened clock, and
--      finishing a unit re-seals nothing. Without this fact, opening such a
--      package forced a false choice — keep the count and lose the opened clock,
--      or switch to a fraction and lose the count — and the first discards truth
--      in the under-reporting direction.
--
-- Nullable, no backfill, no rewritten rows. NULL unit_seal reads as
-- 'individual', which is exactly how existing counted rows already behaved, and
-- stays NULL on a fraction-modeled item where the notion does not apply. TEXT +
-- CHECK rather than a new PG enum: two values, and a value check is re-runnable
-- where CREATE TYPE is not.
--
-- Instance-agnostic empty schema — no seed content.

ALTER TABLE kitchen.inventory_items
    ADD COLUMN IF NOT EXISTS storage_moved_at DATE,
    ADD COLUMN IF NOT EXISTS unit_seal TEXT;

-- Added separately: a CHECK cannot ride ADD COLUMN IF NOT EXISTS idempotently
-- (same shape as 017/018).
DO $$
BEGIN
    ALTER TABLE kitchen.inventory_items
        ADD CONSTRAINT inventory_items_unit_seal_chk
        CHECK (unit_seal IS NULL OR unit_seal IN ('individual', 'shared'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
