-- Kitchen Module: Portion multiplier (post-hoc rescale)
--
-- A post-hoc "I only ate half of that" knob on consumption entries. The stored
-- macro fields remain the BASE (as estimated / recipe-computed / overridden);
-- every serving surface reports EFFECTIVE macros = base * portion_multiplier.
-- Changing the multiplier later always rescales from the base — idempotent,
-- never compounding. See specs/modules/kitchen.md § Portion multiplier.
--
-- NOT NULL DEFAULT 1 backfills every existing row with 1, so effective == base
-- for all pre-existing entries and the wire stays byte-identical until the owner
-- sets a multiplier. CHECK enforces the positive, sane-upper-bound invariant at
-- the storage layer (the API validates the same range).

ALTER TABLE kitchen.entries
    ADD COLUMN portion_multiplier NUMERIC NOT NULL DEFAULT 1
        CHECK (portion_multiplier > 0 AND portion_multiplier <= 20);
