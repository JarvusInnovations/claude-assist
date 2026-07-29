-- Kitchen Module: item merge (specs/modules/kitchen.md § Item corrections).
--
-- Items are the records most likely to be wrong — created fastest and from the
-- least information — and two rows for ONE physical package make the ledger
-- claim MORE stock than reality, the direction nothing downstream flags.
--
-- Retiring the duplicate was already possible (the `dismissed` terminal, added
-- in 004: the only terminal that claims neither consumption nor waste, so a
-- record that was never real leaves the ledger without fabricating either). What
-- was missing is the relink: a consumption entry that depleted the loser, the
-- receipt line that created it, and a conversion that spent it as a source all
-- point at the losing row, and retiring it without moving them strands history
-- against a record that is no longer stock.
--
-- merged_into is the forward pointer that survives that operation: set when the
-- row was retired INTO a surviving item, so a straggler reference can be
-- followed forward and a replayed merge can tell "already done" from "merged
-- somewhere else" (the first is idempotent, the second is a 409). Same shape and
-- reasoning as products.merged_into (017).
--
-- No row is ever deleted. The losing row is what a receipt replay's idempotency
-- and its batch line's provenance rest on.

ALTER TABLE kitchen.inventory_items
    ADD COLUMN IF NOT EXISTS merged_into CHAR(26);

-- Added separately: a CHECK cannot ride ADD COLUMN IF NOT EXISTS idempotently.
DO $$
BEGIN
    ALTER TABLE kitchen.inventory_items
        ADD CONSTRAINT inventory_items_merged_into_ulid_chk
        CHECK (merged_into IS NULL OR merged_into ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
