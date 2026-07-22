-- Kitchen Module: Nutrition panel — sugar + fiber, serving capture, jsonb repair
--
-- Expands the journal's tracked nutrition from 6 fields to the eight-field
-- panel (specs/modules/kitchen.md § Nutrition panel): adds `sugar_g` and
-- `fiber_g` to kitchen.entries. Additive, nullable — unknown is null, never 0.
--
-- Adds raw serving capture to products (§ label scan — capture as printed,
-- scale late): `serving_size_g` (grams per label serving), the label's
-- per-serving panel (`nutrition_per_serving`), an opportunistic
-- `servings_per_container`, and the vision model's count-vs-fraction
-- `unit_model_hint` (a packaging judgment hint — never hard-sets a quantity).
-- Per-100g values are henceforth DERIVED in code (per_serving ÷ serving_size_g
-- × 100) when the raw serving data exists, with the model's own per-100g kept
-- only as a fallback.
--
-- Also repairs double-encoded JSONB: the store layer stringified values before
-- insert, so every products.nutrition_per_100g and recipes.components value is
-- a JSON *string* inside the jsonb column ('"{\"calories\":33}"'), which kills
-- SQL-side inspection (`->>` returns null on all of them). The write path is
-- fixed in code alongside this migration; here we rewrite existing rows to
-- proper objects. Idempotent: only rows whose jsonb_typeof is 'string' are
-- touched.

ALTER TABLE kitchen.entries
    ADD COLUMN IF NOT EXISTS sugar_g NUMERIC,
    ADD COLUMN IF NOT EXISTS fiber_g NUMERIC;

ALTER TABLE kitchen.products
    -- Grams per printed label serving (as transcribed, no model arithmetic).
    ADD COLUMN IF NOT EXISTS serving_size_g NUMERIC,
    -- The label's per-serving panel, as printed: {calories, protein_g, fat_g,
    -- sat_fat_g, carbs_g, sugar_g, fiber_g, sodium_mg}; null field = unreadable.
    ADD COLUMN IF NOT EXISTS nutrition_per_serving JSONB,
    -- Opportunistic package accounting only — never feeds count-vs-fraction.
    ADD COLUMN IF NOT EXISTS servings_per_container NUMERIC,
    -- Vision-model packaging judgment: 'counted' (individually-sealed atomic
    -- units, each opened separately) | 'fraction' (single container drawn
    -- down) | null (not enough info). A hint for the unit-model judgment.
    ADD COLUMN IF NOT EXISTS unit_model_hint TEXT
        CHECK (unit_model_hint IN ('counted', 'fraction') OR unit_model_hint IS NULL);

-- Repair double-encoded jsonb (no-op on healthy rows). The same stringify bug
-- affected every jsonb write site, so all four columns get the same repair.
UPDATE kitchen.products
SET nutrition_per_100g = (nutrition_per_100g #>> '{}')::jsonb
WHERE nutrition_per_100g IS NOT NULL
  AND jsonb_typeof(nutrition_per_100g) = 'string';

UPDATE kitchen.recipes
SET components = (components #>> '{}')::jsonb
WHERE components IS NOT NULL
  AND jsonb_typeof(components) = 'string';

UPDATE kitchen.entries
SET component_quantities = (component_quantities #>> '{}')::jsonb
WHERE component_quantities IS NOT NULL
  AND jsonb_typeof(component_quantities) = 'string';

UPDATE kitchen.inventory_derivations
SET sources = (sources #>> '{}')::jsonb
WHERE sources IS NOT NULL
  AND jsonb_typeof(sources) = 'string';
