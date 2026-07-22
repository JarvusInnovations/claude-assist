-- Kitchen Module: Receipt prices + product net content
-- (specs/modules/kitchen.md § Prices — capture as printed, never computed).
--
-- The receipt parser already reads every line's price to disambiguate
-- quantity markers; these columns stop discarding what it read. Line
-- price_cents is the PRINTED extended price (what was paid for the line's
-- units); batch total_cents is the PRINTED grand total (a soft parse
-- self-check; lines-sum disagreement is informational, never a failure).
-- Product net_content_g/_ml are converted DETERMINISTICALLY in code from the
-- label's transcribed {value, unit} pair — the per-gram denominator for cost
-- reads. All additive + nullable; null = unreadable, never 0.

ALTER TABLE kitchen.purchase_batch_lines
    ADD COLUMN IF NOT EXISTS price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0);

ALTER TABLE kitchen.purchase_batches
    ADD COLUMN IF NOT EXISTS total_cents INTEGER CHECK (total_cents IS NULL OR total_cents >= 0);

ALTER TABLE kitchen.products
    ADD COLUMN IF NOT EXISTS net_content_g NUMERIC CHECK (net_content_g IS NULL OR net_content_g > 0),
    ADD COLUMN IF NOT EXISTS net_content_ml NUMERIC CHECK (net_content_ml IS NULL OR net_content_ml > 0);
