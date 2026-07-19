-- Kitchen Module: Inventory (phase 2)
--
-- Receipts, labels, a receipt lexicon, physical stock state, and
-- events-in-passing. Same idioms as phase 1 (ULID keys, status-as-work-queue,
-- store interface, sweep worker). Everything here is DIRECTIONAL: an on-hand
-- fraction that self-heals at the next event, never a gram ledger. See
-- specs/modules/kitchen.md § Phase 2.
--
-- Instance-agnostic empty schema only — records enter an instance solely
-- through the module's APIs, never as committed seed content.

-- Shelf-life class → default eat-by windows are code-owned (src/inventory-derive.ts):
--   pantry (365/180), frozen (180/90), fridge_long (60/21), fridge_short (14/7),
--   produce (7/4), very_perishable (3/2), unknown (null/null — no eat-by).
CREATE TYPE kitchen.shelf_life_class AS ENUM (
    'pantry',
    'frozen',
    'fridge_long',
    'fridge_short',
    'produce',
    'very_perishable',
    'unknown'
);

-- Physical-unit lifecycle: stocked → open → finished | tossed (both terminal).
CREATE TYPE kitchen.inventory_state AS ENUM (
    'stocked',
    'open',
    'finished',
    'tossed'
);

CREATE TYPE kitchen.batch_source AS ENUM (
    'receipt',   -- posted from a receipt photo, parsed asynchronously
    'manual'     -- a verbal/agentic entry (no photo parse)
);

-- Parse work queue for a receipt batch (mirrors kitchen.entry_status).
CREATE TYPE kitchen.batch_status AS ENUM (
    'parsing',   -- awaiting the receipt-model parse pass (or none configured)
    'parsed',    -- lines extracted + resolved
    'failed'     -- parse attempts exhausted; the batch is still inspectable
);

CREATE TYPE kitchen.line_match_outcome AS ENUM (
    'pending',    -- not yet resolved against the lexicon
    'matched',    -- resolved to a product via the lexicon
    'unmatched'   -- no lexicon hit; a needs_info item was created
);

-- Durable facts about a KIND of item (not a physical unit). A label photo
-- enriches the product; inventory items carry only temporal state.
CREATE TABLE kitchen.products (
    ulid CHAR(26) PRIMARY KEY
        CHECK (ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),

    name TEXT NOT NULL,
    shelf_life_class kitchen.shelf_life_class NOT NULL DEFAULT 'unknown',
    aliases TEXT[] NOT NULL DEFAULT '{}',           -- alternate names for matching
    -- {calories, protein_g, fat_g, sat_fat_g, carbs_g, sodium_mg}; null field = unknown
    nutrition_per_100g JSONB,
    package_size TEXT,                              -- e.g. "16 oz", "12 ct"

    -- Label-derived precise overrides of the class default windows (days).
    shelf_life_days_unopened INTEGER,
    shelf_life_days_opened INTEGER,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kitchen_products_name ON kitchen.products(name);

-- One row per (store, receipt-line text). Grows monotonically: once a line is
-- mapped, every future receipt carrying it resolves automatically.
CREATE TABLE kitchen.receipt_lexicon (
    ulid CHAR(26) PRIMARY KEY
        CHECK (ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),

    store TEXT NOT NULL,
    line_text TEXT NOT NULL,                        -- exact receipt line (normalized upper/trim)
    product_ulid CHAR(26) NOT NULL
        CHECK (product_ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
    package_size TEXT,
    shelf_life_class kitchen.shelf_life_class,      -- optional per-line override

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (store, line_text)
);

-- One physical unit in the house.
CREATE TABLE kitchen.inventory_items (
    ulid CHAR(26) PRIMARY KEY
        CHECK (ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),

    product_ulid CHAR(26)                           -- null while needs_info
        CHECK (product_ulid IS NULL OR product_ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
    raw_label TEXT,                                 -- receipt line / display name when no product
    store TEXT,
    batch_ulid CHAR(26)
        CHECK (batch_ulid IS NULL OR batch_ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),

    state kitchen.inventory_state NOT NULL DEFAULT 'stocked',
    on_hand_fraction NUMERIC NOT NULL DEFAULT 1.0   -- directional 0..1
        CHECK (on_hand_fraction >= 0 AND on_hand_fraction <= 1),
    needs_info BOOLEAN NOT NULL DEFAULT FALSE,

    acquired_at DATE NOT NULL,
    opened_at DATE,
    closed_at DATE,                                 -- finished/tossed date
    eat_by DATE,                                    -- DERIVED (materialized for ordering)
    shelf_life_class kitchen.shelf_life_class,      -- snapshot for derivation

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Eat-first ordering: on-hand items by eat-by urgency (nulls last).
CREATE INDEX idx_kitchen_items_eat_by ON kitchen.inventory_items(eat_by)
    WHERE state IN ('stocked', 'open');
CREATE INDEX idx_kitchen_items_state ON kitchen.inventory_items(state);
CREATE INDEX idx_kitchen_items_needs_info ON kitchen.inventory_items(acquired_at)
    WHERE needs_info = TRUE;

-- One shopping event.
CREATE TABLE kitchen.purchase_batches (
    -- Client-supplied ULID: the receipt POST's idempotency key.
    ulid CHAR(26) PRIMARY KEY
        CHECK (ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),

    source kitchen.batch_source NOT NULL DEFAULT 'receipt',
    store TEXT,
    purchased_at DATE NOT NULL,
    status kitchen.batch_status NOT NULL DEFAULT 'parsing',

    parse_attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_error_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kitchen_batches_status ON kitchen.purchase_batches(status);
CREATE INDEX idx_kitchen_batches_parsing ON kitchen.purchase_batches(created_at)
    WHERE status = 'parsing';

-- One parsed receipt line.
CREATE TABLE kitchen.purchase_batch_lines (
    ulid CHAR(26) PRIMARY KEY
        CHECK (ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),

    batch_ulid CHAR(26) NOT NULL
        REFERENCES kitchen.purchase_batches(ulid) ON DELETE CASCADE,
    raw_text TEXT NOT NULL,
    match_outcome kitchen.line_match_outcome NOT NULL DEFAULT 'pending',
    product_ulid CHAR(26)
        CHECK (product_ulid IS NULL OR product_ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
    inventory_item_ulid CHAR(26)
        CHECK (inventory_item_ulid IS NULL OR inventory_item_ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kitchen_batch_lines_batch ON kitchen.purchase_batch_lines(batch_ulid);

-- Phase-1 entries gain the optional inventory-item link the depletion matcher
-- sets (no FK: an entry may be deleted independently of its item, and vice
-- versa).
ALTER TABLE kitchen.entries
    ADD COLUMN inventory_item_ulid CHAR(26)
        CHECK (inventory_item_ulid IS NULL OR inventory_item_ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$');

-- updated_at triggers (reuse kitchen.update_updated_at from 001).
CREATE TRIGGER kitchen_products_updated_trigger
  BEFORE UPDATE ON kitchen.products
  FOR EACH ROW EXECUTE FUNCTION kitchen.update_updated_at();

CREATE TRIGGER kitchen_lexicon_updated_trigger
  BEFORE UPDATE ON kitchen.receipt_lexicon
  FOR EACH ROW EXECUTE FUNCTION kitchen.update_updated_at();

CREATE TRIGGER kitchen_items_updated_trigger
  BEFORE UPDATE ON kitchen.inventory_items
  FOR EACH ROW EXECUTE FUNCTION kitchen.update_updated_at();

CREATE TRIGGER kitchen_batches_updated_trigger
  BEFORE UPDATE ON kitchen.purchase_batches
  FOR EACH ROW EXECUTE FUNCTION kitchen.update_updated_at();
