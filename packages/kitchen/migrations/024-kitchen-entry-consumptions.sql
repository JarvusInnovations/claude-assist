-- Kitchen Module: entry -> item depletion ledger
-- (specs/modules/kitchen.md § Data model `kitchen.entry_consumptions`,
-- § Stated-weight consumption, § Eaten sheets decrement their sources).
--
-- A meal is built from several tracked components, so one journal entry
-- legitimately depletes several inventory items. `entries.inventory_item_ulid`
-- is a single column and can hold exactly one, so the first component claimed
-- it and every later one was refused as a conflict with it: a six-component
-- eaten worksheet decremented two items and reported four refusals. The
-- refusals were honest; the model underneath them was wrong.
--
-- The idempotency key was always meant to be the PAIR — "has THIS entry already
-- depleted THIS item?" — which is what the primary key here states. A repeat of
-- the same pair is a replay; the same entry against a different item is the next
-- component.
--
-- `amount`/`amount_kind` record the decrement that was actually APPLIED, in the
-- item's own unit model ('fraction' of a package, or whole 'units') rather than
-- as requested — a stated 50g off a 500g package is 0.1 fraction here, because
-- that is the movement the ledger made. Both are NULL together when the amount
-- is unknown, which is precisely the state of a row backfilled from the old
-- column: it recorded that a depletion happened and never how much, and
-- inventing a number for it would fabricate ledger history.
--
-- `entries.inventory_item_ulid` is KEPT, demoted to a derived convenience: it is
-- in the Entry wire shape clients already read, `consume()` still sets it in the
-- same INSERT that creates the entry (an atomicity property worth not
-- disturbing), and it is the exactly-right key for the depletion matcher's one
-- question — "has this entry depleted anything at all?" This table is
-- authoritative for the full set.

CREATE TABLE IF NOT EXISTS kitchen.entry_consumptions (
    -- FK + ON DELETE CASCADE reproduces what the single column did for free:
    -- deleting an entry retracted its depletion claim, because the claim lived
    -- on the deleted row. Without it a stale row would suppress the decrement
    -- for a re-logged entry that reuses the ULID.
    entry_ulid CHAR(26) NOT NULL
        REFERENCES kitchen.entries(ulid) ON DELETE CASCADE,

    -- No FK, matching every other item reference in the module: an item may be
    -- retired or merged independently of the entries that depleted it, and the
    -- merge path repoints these rows explicitly (§ Item corrections).
    item_ulid CHAR(26) NOT NULL
        CHECK (item_ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),

    amount DOUBLE PRECISION,
    amount_kind TEXT
        CHECK (amount_kind IS NULL OR amount_kind IN ('fraction', 'units')),
    -- Known together or unknown together — an amount with no unit model is not
    -- a quantity, and a unit model with no amount is not a record.
    CONSTRAINT entry_consumptions_amount_pair_chk
        CHECK ((amount IS NULL) = (amount_kind IS NULL)),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (entry_ulid, item_ulid)
);

-- The merge/relink direction: "every entry that depleted this item".
CREATE INDEX IF NOT EXISTS idx_kitchen_entry_consumptions_item
    ON kitchen.entry_consumptions(item_ulid);

-- Backfill: every link the single column already holds becomes a row, amount
-- unknown. ON CONFLICT so a re-run is a no-op.
INSERT INTO kitchen.entry_consumptions (entry_ulid, item_ulid, amount, amount_kind, created_at)
SELECT e.ulid, e.inventory_item_ulid, NULL, NULL, e.created_at
FROM kitchen.entries e
WHERE e.inventory_item_ulid IS NOT NULL
ON CONFLICT (entry_ulid, item_ulid) DO NOTHING;
