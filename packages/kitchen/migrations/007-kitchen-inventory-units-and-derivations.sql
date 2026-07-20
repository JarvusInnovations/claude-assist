-- Kitchen Module: Unit counts + conversion provenance (phase 2)
--
-- Two additive pieces, from deepening the inventory model into a small graph
-- (see specs/modules/kitchen.md § count-vs-fraction principle, § Conversions):
--
--   1. inventory_items.units_total / units_remaining — the sealed-unit COUNT
--      model, an alternative to on_hand_fraction for a discrete multipack of
--      individually-sealed atomic units (a can 3-pack, an egg dozen, a
--      sausage-link pack, a yogurt 4-pack). Both columns are nullable and
--      travel together: NULL/NULL (the default) means the item stays
--      fraction-modeled, unchanged; both set means the item tracks a count
--      instead, as ONE row (no fan-out per physical unit — the fan-out
--      mechanism that already exists for multi-quantity RECEIPT LINES is a
--      different axis: N bought units of a product each become their own
--      item row, and any one of those rows may itself be a sealed multipack
--      with its own units_total).
--   2. kitchen.inventory_derivations — minimal provenance for a `convert`
--      event: which source item(s) a derived (prepared) item was made from,
--      and optionally the recipe/conversion that fixes its macros. One row
--      per derived item (1:1, since a derived item is always freshly created
--      by exactly one conversion). Deliberately NOT a full lineage graph —
--      `sources` is a flat JSONB list of {item_ulid, amount, amount_kind},
--      enough for eat-first reasoning and later macro inheritance.
--
-- Both additive with safe (nullable/empty) defaults, so existing rows are
-- unaffected and the file is transaction-safe under the migration runner.
-- Instance-agnostic empty schema — no seed content.

ALTER TABLE kitchen.inventory_items
    ADD COLUMN units_total INTEGER,
    ADD COLUMN units_remaining INTEGER;

ALTER TABLE kitchen.inventory_items
    ADD CONSTRAINT inventory_items_units_paired
        CHECK ((units_total IS NULL) = (units_remaining IS NULL)),
    ADD CONSTRAINT inventory_items_units_total_positive
        CHECK (units_total IS NULL OR units_total >= 1),
    ADD CONSTRAINT inventory_items_units_remaining_range
        CHECK (units_remaining IS NULL OR (units_remaining >= 0 AND units_remaining <= units_total));

CREATE TABLE kitchen.inventory_derivations (
    ulid CHAR(26) PRIMARY KEY
        CHECK (ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),

    derived_item_ulid CHAR(26) NOT NULL UNIQUE
        REFERENCES kitchen.inventory_items(ulid) ON DELETE CASCADE,
    -- [{item_ulid, amount, amount_kind: 'fraction'|'count'}] — the sources a
    -- conversion consumed to produce this item, and how much of each.
    sources JSONB NOT NULL DEFAULT '[]',
    recipe_ulid CHAR(26)
        CHECK (recipe_ulid IS NULL OR recipe_ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kitchen_derivations_derived_item ON kitchen.inventory_derivations(derived_item_ulid);
