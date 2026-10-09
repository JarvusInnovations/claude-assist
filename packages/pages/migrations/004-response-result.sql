-- The cook-mode result, stored on the processed response row
-- (specs/modules/pages.md § Order of writes, § Idempotency).
--
-- A cook-mode submission's key identifies the write it performed. When the
-- same key is submitted again with the SAME payload (a retry over a dropped
-- network, a reload of the page), the answer is the ORIGINAL result — what was
-- written, which decrements applied, which were refused and why. That result
-- was previously returned once and discarded; it lands here when the row is
-- marked processed, so a replay can answer with it.
--
-- Additive and nullable: every row processed before this carries NULL, and a
-- replay of one reports the write with no decrement detail.

ALTER TABLE pages.responses
    ADD COLUMN result JSONB;

-- The same-key lookup a cook-mode submission performs before it appends
-- (§ Idempotency: same key + different payload → 409). Worksheet payloads
-- carry their key at the top level; free-form payloads have none and index
-- as NULL.
CREATE INDEX idx_responses_submission_key
    ON pages.responses (page_id, (payload->>'submission_key'))
    WHERE payload->>'submission_key' IS NOT NULL;
