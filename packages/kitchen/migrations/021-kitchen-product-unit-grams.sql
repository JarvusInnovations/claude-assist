-- Kitchen Module: per-unit edible grams + panel provenance
-- (specs/modules/kitchen.md § Data model § Per-unit edible grams and panel
-- provenance).
--
-- Two additive, nullable product columns, both gating a later widening of
-- one-tap consume (plans/consume-counted-purchased.md) that this migration
-- does not itself implement.
--
--   1. unit_edible_g — the edible mass of ONE physical unit of a counted
--      product (one egg, one can, one link). STATED, never derived: the two
--      neighbouring fields each answer a different question and neither
--      substitutes for this one, in opposite directions. serving_size_g is
--      the label's SERVING, which equals one unit only by coincidence — a
--      large-egg carton's 50 g serving happens to be one egg, but a 3-can
--      multipack can print an 85 g serving against a ~142 g can, so deriving
--      from serving_size_g would silently log 60% of a can. Going the other
--      way, net_content_g ÷ (an item's units_total) includes inedible mass —
--      shell for eggs, packing water for canned goods — so a dozen-egg
--      carton's ~681 g net weight ÷ 12 yields ~56.75 g, overstating the ~50 g
--      that is actually edible. Neither error is detectable at read time,
--      which is the entire justification for a third column. Null leaves the
--      product ineligible for one-tap consume; it is never an error.
--
--   2. nutrition_source — where the panel came from: 'label' (a scanned
--      package, authoritative for that SKU), 'reference' (correct for the
--      food but generic for the SKU — the only option for unpackaged produce,
--      which carries no label), or 'estimate' (a guess). Without this marker
--      a reference-seeded row is indistinguishable from a scanned package,
--      there is no safe upgrade rule, and the needs_nutrition sweep cannot
--      tell NO data from GENERIC data. Provenance is orthogonal to basis (a
--      label panel is normally per-serving, a reference panel per-100g, but
--      neither field implies the other).
--
-- Nullable, no backfill of unit_edible_g (nothing in the existing data states
-- it, and inferring it would be exactly the mistake this column exists to
-- prevent). nutrition_source IS backfilled, conservatively: 'label' only
-- where label evidence exists on the row already — a populated
-- (serving_size_g, nutrition_per_serving) pair, which only the label-scan
-- write path has ever populated — and 'reference' for every other row.
-- Erring upward (a false 'label') is the unsafe direction: it would make the
-- supersession rule below refuse the real scan that later corrects it, so
-- the backfill never guesses 'label' from anything short of that evidence.
--
-- TEXT + CHECK rather than a new PG enum, matching 009/020: a short fixed
-- set of values, and a CHECK is re-runnable where CREATE TYPE is not.

ALTER TABLE kitchen.products
    ADD COLUMN IF NOT EXISTS unit_edible_g NUMERIC,
    ADD COLUMN IF NOT EXISTS nutrition_source TEXT;

-- Added separately: a CHECK cannot ride ADD COLUMN IF NOT EXISTS idempotently
-- (same shape as 009/017/020).
DO $$
BEGIN
    ALTER TABLE kitchen.products
        ADD CONSTRAINT products_unit_edible_g_positive_chk
        CHECK (unit_edible_g IS NULL OR unit_edible_g > 0);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE kitchen.products
        ADD CONSTRAINT products_nutrition_source_chk
        CHECK (nutrition_source IS NULL OR nutrition_source IN ('label', 'reference', 'estimate'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Conservative backfill (see above): 'label' only where label evidence
-- already exists on the row; 'reference' everywhere else. Idempotent — only
-- touches rows where nutrition_source is still unset.
UPDATE kitchen.products
SET nutrition_source = CASE
    WHEN serving_size_g IS NOT NULL AND nutrition_per_serving IS NOT NULL THEN 'label'
    ELSE 'reference'
END
WHERE nutrition_source IS NULL;
