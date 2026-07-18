-- Kitchen Module: Consumption Journal (phase 1)
--
-- Sibling of the capture module — same idioms (ULID-keyed idempotent upserts,
-- status-as-work-queue, sweep worker) applied to consumption entries and
-- recipes. See specs/modules/kitchen.md.
--
-- Status state machine (src/state.ts is the code authority):
--
--   estimating ──model estimate ok──> estimated
--       │                                 ▲
--       │  (attempts exhausted)           │ (recipe-computed / reselect-cloned:
--       └──────────────> failed           │  skips estimating entirely)
--                                         │
--       manual macro override ───────────>┘ (terminal — source='manual', no
--                                            later model pass may overwrite it)
--
-- Recipes are named loggable templates. Sheet-sourced recipes are a
-- read-through projection of the configured meal-bank gitsheet (never
-- written here); only pushed/promoted recipes are persisted as rows.

CREATE TYPE kitchen.entry_status AS ENUM (
    'estimating',  -- awaiting a model estimate (no deterministic source yet)
    'estimated',   -- nutrition resolved (model, reselect, or manual)
    'failed'       -- attempt-capped; valid, rollup-visible, awaiting a manual label
);

CREATE TYPE kitchen.estimation_source AS ENUM (
    'model',      -- one vision/text estimation call
    'reselect',   -- recipe-computed (deterministic) or cloned from the reselect strip
    'manual'      -- the owner's correction; terminal, survives every later pass
);

CREATE TYPE kitchen.recipe_source AS ENUM (
    'sheet',     -- read-through projection of the meal-bank gitsheet (never written here)
    'pushed',    -- agent-pushed one-off or reusable template
    'promoted'   -- created from a logged entry via POST /entries/:ulid/promote
);

CREATE TABLE kitchen.recipes (
    ulid CHAR(26) PRIMARY KEY
        CHECK (ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),

    name TEXT NOT NULL,
    -- Per-ingredient components: [{label, default_qty_g, per_100g: {calories, protein_g, sat_fat_g}}]
    components JSONB NOT NULL DEFAULT '[]',
    source kitchen.recipe_source NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kitchen_recipes_name ON kitchen.recipes(name);

CREATE TABLE kitchen.entries (
    -- Client-generated ULID: the idempotency key. Offline clients retry
    -- freely; first write wins for the row's identity fields, but (unlike
    -- capture) a replay while status='estimating' re-attempts estimation
    -- with the freshly-supplied photos — see src/services/pipeline.ts.
    -- Photos are never persisted; only text/derived fields land here.
    ulid CHAR(26) PRIMARY KEY
        CHECK (ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),

    logged_at TIMESTAMPTZ NOT NULL,        -- client clock (the meal's time)
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    note TEXT,
    label TEXT,                             -- resolved display label

    -- Nutrition estimate (flattened; NULL fields are "unknown", not zero)
    calories NUMERIC,
    protein_g NUMERIC,
    fat_g NUMERIC,
    sat_fat_g NUMERIC,
    carbs_g NUMERIC,
    sodium_mg NUMERIC,
    confidence NUMERIC,                     -- 0..1; NULL for manual overrides
    portion_basis TEXT,

    source kitchen.estimation_source,       -- NULL until resolved
    status kitchen.entry_status NOT NULL DEFAULT 'estimating',

    -- Work-queue bookkeeping (mirrors capture.captures' attempt/error pair)
    estimate_attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_error_at TIMESTAMPTZ,

    -- Optional recipe reference + the quantities actually used. No FK: a
    -- referenced recipe may be a sheet-sourced projection that has no row
    -- in kitchen.recipes at all.
    recipe_ulid CHAR(26)
        CHECK (recipe_ulid IS NULL OR recipe_ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
    component_quantities JSONB,             -- [{label, quantity_g}]

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kitchen_entries_logged_at ON kitchen.entries(logged_at DESC);
CREATE INDEX idx_kitchen_entries_status ON kitchen.entries(status);
CREATE INDEX idx_kitchen_entries_estimating ON kitchen.entries(logged_at)
    WHERE status = 'estimating';
CREATE INDEX idx_kitchen_entries_label ON kitchen.entries(label)
    WHERE label IS NOT NULL;

CREATE OR REPLACE FUNCTION kitchen.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER kitchen_recipes_updated_trigger
  BEFORE UPDATE ON kitchen.recipes
  FOR EACH ROW EXECUTE FUNCTION kitchen.update_updated_at();

CREATE TRIGGER kitchen_entries_updated_trigger
  BEFORE UPDATE ON kitchen.entries
  FOR EACH ROW EXECUTE FUNCTION kitchen.update_updated_at();
