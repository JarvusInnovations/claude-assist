-- Kitchen Module: added sugar — the ninth panel field
--
-- Splits added sugar out of total sugar (specs/modules/kitchen.md § Nutrition
-- panel): `sugar_g` stays TOTAL sugar and loses its target; the new
-- `added_sugar_g` carries the ceiling. There is no established guideline for
-- total sugar (WHO's 10%/5%-of-energy thresholds and the AHA limits govern
-- free/added sugars and explicitly exclude the intrinsic sugars of whole fruit
-- and milk), so a total-sugar line fires hardest on the best-eating days.
--
-- Additive and nullable: existing rows stay NULL, which is the honest value —
-- added sugar was never captured for them, and NULL means unknown (never 0,
-- which would fabricate a clean day). NO BACKFILL is performed or intended.
--
-- Only kitchen.entries needs DDL. Everywhere else the panel is persisted it
-- rides an existing JSONB column and needs no migration:
--   * kitchen.products.nutrition_per_100g / nutrition_per_serving (JSONB)
--   * kitchen.recipes.components[].per_100g (JSONB)
--   * derived (prepared) inventory items, whose macros are computed at consume
--     time from their recipe rather than stored (kitchen.inventory_derivations
--     holds provenance only).

ALTER TABLE kitchen.entries
    ADD COLUMN IF NOT EXISTS added_sugar_g NUMERIC;
