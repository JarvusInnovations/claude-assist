-- Capture Module: attachments
--
-- Captures may carry any number of file/photo attachments. The bytes live in
-- an object-store bucket; the capture row only references them. Each entry is
-- {object_key, filename, content_type, bytes}. The object key is ULID-keyed
-- (captures/<ulid>/<n>-<filename>) so replays overwrite the same object.
--
-- Modeled as a JSONB column on captures (not a side table) to match the
-- module's conventions: attachments are 1:1-with-capture raw input, always
-- read together with the row and never queried independently — exactly like
-- the existing urls[]/tags[] arrays and the payload/classification JSONB. The
-- side table in this schema (capture.references) is reserved for downstream
-- projections with their own lifecycle, which attachments are not.
--
-- Downstream surfaces render attachments via short-lived signed READ URLs
-- generated on demand from the object keys — nothing is ever public, and no
-- URL is stored here.

ALTER TABLE capture.captures
    ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]';
