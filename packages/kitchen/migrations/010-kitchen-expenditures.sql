-- Kitchen Module: Expenditure & net energy (specs/modules/kitchen.md
-- § Expenditure & net energy, claude-assist#121).
--
-- One row per activity/burn. Numbers always arrive STATED (a device said it,
-- or the owner did) — there is no model-estimation path for a burn. The daily
-- net line ((KITCHEN_TDEE_BASE + expenditure) − intake) is computed at read
-- time; nothing here stores a derived balance.

CREATE TABLE IF NOT EXISTS kitchen.expenditures (
    ulid CHAR(26) PRIMARY KEY,
    -- The activity's own moment (backdatable), not the row's arrival time.
    occurred_at TIMESTAMPTZ NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('strava', 'health_connect', 'garmin', 'manual')),
    label TEXT NOT NULL,
    -- Active calories, not gross.
    kcal NUMERIC NOT NULL CHECK (kcal >= 0),
    duration_min NUMERIC,
    avg_hr NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kitchen_expenditures_occurred
    ON kitchen.expenditures (occurred_at DESC);
