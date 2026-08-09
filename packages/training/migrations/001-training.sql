-- Weekly adaptive training plans (specs/modules/training.md).
--
-- One row per (week, generation). A generated week is born `proposed` and only
-- becomes `active` when a human resolves the approval gate that was raised
-- alongside it — the module NEVER waits for that. `proposed` is the durable
-- record of "we asked"; reconciliation is a separate, later pass.
--
-- Sessions and the inputs they were synthesized from are stored as JSONB rather
-- than normalized: nothing queries inside them, and keeping the whole synthesis
-- input snapshot beside the output is what makes a past week's plan explicable
-- ("what did it know when it decided this?") after the forecast has moved on.

CREATE SCHEMA IF NOT EXISTS training;

CREATE TABLE training.week_plans (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Monday of the plan week, in the module's configured zone.
    week_start    DATE NOT NULL,
    status        TEXT NOT NULL DEFAULT 'proposed'
                  CHECK (status IN ('proposed','active','rejected','superseded','expired')),
    -- One-line headline for the week (briefing + notification title).
    summary       TEXT NOT NULL DEFAULT '',
    -- Why this week looks the way it does, grounded in the input snapshot.
    rationale     TEXT NOT NULL DEFAULT '',
    -- What changed relative to the previously active week — the "adjustment
    -- proposal" a human is actually being asked to approve.
    adjustments   JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- PlannedSession[] — one entry per day the plan speaks to.
    sessions      JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Snapshot of the synthesis inputs (activity history, forecast, availability).
    inputs        JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- The approvals-module request this plan is gated on, and its dedupe key.
    approval_id   TEXT,
    approval_key  TEXT,
    model         TEXT,
    generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one ACTIVE plan per week. A newly approved plan supersedes the
-- previous one in the same transaction, so this is an invariant, not a race.
CREATE UNIQUE INDEX training_one_active_per_week
    ON training.week_plans (week_start)
    WHERE status = 'active';

-- At most one PROPOSED plan per week, for the same reason the approvals module
-- dedupes pending rows: a re-run of the weekly job must not stack proposals.
CREATE UNIQUE INDEX training_one_proposed_per_week
    ON training.week_plans (week_start)
    WHERE status = 'proposed';

CREATE INDEX idx_training_week ON training.week_plans (week_start DESC, generated_at DESC);
CREATE INDEX idx_training_proposed ON training.week_plans (generated_at)
    WHERE status = 'proposed';
