-- Kitchen Module: Weigh-ins (specs/modules/kitchen.md § Weigh-ins — scale
-- data via the capture app, claude-assist#121).
--
-- Every reading is a row — same-morning repeats and non-scale writers
-- included. Noise is handled at read time (daily median + 7-day trend in
-- the GET /kitchen/weight derivation); nothing here stores a derived value.
--
-- occurred_at is TIMESTAMPTZ, which postgres normalizes to UTC and thereby
-- LOSES the poster's original zone offset. The spec requires day bucketing
-- by each reading's OWN offset (only the device knows its clock), so the
-- offset is persisted alongside as tz_offset_minutes, captured verbatim
-- from the POST body's explicit-offset occurred_at at ingest.

CREATE TABLE IF NOT EXISTS kitchen.weigh_ins (
    ulid CHAR(26) PRIMARY KEY,
    -- The reading's own moment. The poster MUST supply an explicit UTC
    -- offset (zone-naive input is a 400 at the route, never a guess).
    occurred_at TIMESTAMPTZ NOT NULL,
    -- Minutes east of UTC from the POSTed occurred_at's offset (e.g. -240
    -- for -04:00). Preserves the reading's local day across the timestamptz
    -- UTC normalization above.
    tz_offset_minutes INTEGER NOT NULL,
    weight_kg NUMERIC NOT NULL CHECK (weight_kg > 0),
    -- Nullable: the scale writes weight+body-fat pairs; other writers
    -- (e.g. Garmin's own weight row) send weight alone.
    body_fat_pct NUMERIC CHECK (body_fat_pct >= 0 AND body_fat_pct <= 100),
    -- Writer package id (Health Connect data origin) or 'manual'.
    source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kitchen_weigh_ins_occurred
    ON kitchen.weigh_ins (occurred_at DESC);
