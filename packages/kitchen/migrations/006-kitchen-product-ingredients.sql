-- Kitchen Module: Product ingredients (phase 2)
--
-- One additive column from live-fire feedback: a label scan can now bank the
-- product's printed ingredients list alongside its nutrition panel (see
-- specs/modules/kitchen.md § Data model, POST /inventory/:ulid/label). The
-- label parser extracts it when a photo shows the ingredients panel; enrichment
-- follows the same precedence as the other product fields (explicit meta >
-- parsed > keep existing, never null-clobbering).
--
-- The paired nutrition-panel expansion (fiber_g + sugar_g) needs no DDL:
-- nutrition_per_100g is JSONB, so the two new keys ride the existing column.
--
-- Additive with a null default, so existing rows are unaffected and the file is
-- transaction-safe under the migration runner. Instance-agnostic empty schema —
-- no seed content.

ALTER TABLE kitchen.products
    ADD COLUMN ingredients TEXT;
