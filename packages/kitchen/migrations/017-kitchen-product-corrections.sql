-- Kitchen Module: product corrections + the negligible marker
-- (specs/modules/kitchen.md § Product corrections, § Nutritionally negligible
-- products).
--
-- Products accrete facts: a receipt seeds a bare name, a label scan adds a
-- panel, the owner fixes a mangled store abbreviation. Creation was the only
-- write, so a product born without nutrition could never be enriched — and
-- re-posting it minted a duplicate rather than correcting the original.
--
-- nutrition_negligible — the owner's assertion that every panel field is ~0 at
-- any realistic serving (spices, salt, vinegar, black coffee, extracts). It
-- exists because `needs_nutrition` is otherwise unclearable for a whole
-- category: a US spice jar carries NO Nutrition Facts panel at all (FDA exempts
-- foods with insignificant amounts of every nutrient), so there is nothing to
-- rescan. A flag nobody can clear trains the reader to ignore the flag,
-- including on the items that ARE actionable. NOT NULL DEFAULT FALSE, and
-- deliberately NOT backfilled by any heuristic — marking is a per-product act.
--
-- archived_at / merged_into — retirement stamps. Archive, never delete: an
-- inventory item's product_ulid, a receipt_lexicon mapping, and a
-- purchase_batch_lines row all point at products, and none may dangle because a
-- duplicate was cleaned up. Same "state, not delete" idiom as recipes (015) and
-- the inventory terminals. merged_into is set when the row was retired INTO a
-- survivor by a merge, so a straggler reference can be followed forward.
--
-- NULL archived_at = live. Listings and the name-key upsert filter on it; a
-- lookup by ULID deliberately does NOT, so history keeps resolving forever.

ALTER TABLE kitchen.products
    ADD COLUMN IF NOT EXISTS nutrition_negligible BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS merged_into CHAR(26);

-- Added separately: a CHECK cannot ride ADD COLUMN IF NOT EXISTS idempotently.
DO $$
BEGIN
    ALTER TABLE kitchen.products
        ADD CONSTRAINT products_merged_into_ulid_chk
        CHECK (merged_into IS NULL OR merged_into ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- The name-key upsert's lookup is "live products by normalized name"; the
-- listing read is the same live set ordered by name.
CREATE INDEX IF NOT EXISTS products_live_name_idx
    ON kitchen.products (name)
    WHERE archived_at IS NULL;
