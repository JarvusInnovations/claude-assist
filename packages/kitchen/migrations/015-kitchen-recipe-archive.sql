-- Kitchen Module: recipe retirement (specs/modules/kitchen.md § Recipe
-- corrections).
--
-- Recipes are tapped from the reselect strip by NAME — a pill carries a name,
-- not a ULID — so a same-named duplicate is indistinguishable to whoever taps
-- one, and the stale fork keeps logging the wrong numbers. Correction therefore
-- replaces (POST /recipes upserts on the normalized name, or on an explicit
-- ulid), and retirement archives.
--
-- Archive, never delete: an entry's recipe_ulid, a promoted recipe's component
-- reconstruction, and a derived inventory item's derivation provenance all
-- point at recipes, and none of them may dangle because a template was retired.
-- Same "state, not delete" idiom the inventory terminals already use — the row
-- survives and a filter, not a row removal, takes it off the live surfaces.
--
-- NULL = live. Reads that serve the strip (and every merged recipe listing)
-- filter on it; a lookup by ULID deliberately does NOT, so history keeps
-- resolving forever.

ALTER TABLE kitchen.recipes
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- The strip/listing read is "live recipes by name"; the upsert's key lookup is
-- the same set matched on a normalized name.
CREATE INDEX IF NOT EXISTS recipes_live_name_idx
    ON kitchen.recipes (name)
    WHERE archived_at IS NULL;
