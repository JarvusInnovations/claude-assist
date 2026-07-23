-- Re-repair double-encoded jsonb. Migration 009's repair was correct but the
-- write-path "fix" that shipped with it (an explicit ::jsonb cast on the
-- bound parameter) was a no-op under porsager/postgres — a JS string bound
-- to a jsonb column arrives as a jsonb STRING SCALAR already, and casting
-- jsonb→jsonb parses nothing. Every jsonb write since re-double-encoded its
-- row. The write paths now use sql.json() (the correct API, verified
-- empirically); this migration repairs rows written in the interim.
-- Idempotent: only string-typed values are touched.

UPDATE kitchen.products
SET nutrition_per_100g = (nutrition_per_100g #>> '{}')::jsonb
WHERE nutrition_per_100g IS NOT NULL AND jsonb_typeof(nutrition_per_100g) = 'string';

UPDATE kitchen.products
SET nutrition_per_serving = (nutrition_per_serving #>> '{}')::jsonb
WHERE nutrition_per_serving IS NOT NULL AND jsonb_typeof(nutrition_per_serving) = 'string';

UPDATE kitchen.recipes
SET components = (components #>> '{}')::jsonb
WHERE components IS NOT NULL AND jsonb_typeof(components) = 'string';

UPDATE kitchen.entries
SET component_quantities = (component_quantities #>> '{}')::jsonb
WHERE component_quantities IS NOT NULL AND jsonb_typeof(component_quantities) = 'string';

UPDATE kitchen.inventory_derivations
SET sources = (sources #>> '{}')::jsonb
WHERE sources IS NOT NULL AND jsonb_typeof(sources) = 'string';
