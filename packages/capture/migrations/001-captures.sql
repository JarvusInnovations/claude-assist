-- Capture Module: Capture Queue
--
-- The single dumb-fast entry point for stray thoughts, links, and (future)
-- diet entries. Clients POST raw items with a client-generated ULID; all
-- classification/routing intelligence happens server-side after the fact
-- ("capture must be dumber than routing").
--
-- Status state machine (see src/state.ts — the code is the authority):
--
--   queued ──classify──> classified ──route(write ok)──────> routed
--                          │  ▲                        ▲
--                          │  └──(correction, any row)─┘ (re-route after correction)
--                          ├─route(hold destination)──> awaiting_review
--                          └─route(no executor)───────> awaiting_executor ──> routed
--
-- Failures never change status: they bump *_attempts + last_error, and the
-- scheduler stops selecting a row once attempts hit the cap (mirrors
-- google.emails triage_attempts). A correction resets the row to
-- 'classified' with a new destination and cleared route attempts.

CREATE TYPE capture.capture_status AS ENUM (
    'queued',             -- stored, awaiting classification
    'classified',         -- classified, awaiting routing execution
    'awaiting_executor',  -- destination has no registered executor (e.g. Tana not configured)
    'awaiting_review',    -- held for Chris's explicit review/synthesis (actionable, team_relevant)
    'routed'              -- destination write succeeded
);

CREATE TABLE capture.captures (
    -- Client-generated ULID: the idempotency key. Offline clients retry
    -- freely; first write wins, replays are acknowledged without clobbering
    -- server-side state (see ON CONFLICT DO NOTHING in the store).
    ulid CHAR(26) PRIMARY KEY
        CHECK (ulid ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),

    source TEXT NOT NULL CHECK (source IN ('app', 'slack', 'terminal')),

    -- Raw capture payload — everything the client sends, nothing more.
    text TEXT NOT NULL,
    type_hint TEXT,                       -- freeform client hint, advisory only
    urls TEXT[] NOT NULL DEFAULT '{}',
    tags TEXT[] NOT NULL DEFAULT '{}',
    -- Extension point for future entry types (e.g. diet: portion note,
    -- photo count, reselect reference). Opaque to the capture endpoint.
    payload JSONB NOT NULL DEFAULT '{}',

    captured_at TIMESTAMPTZ NOT NULL,     -- client clock (offline queue replay)
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Workflow state machine
    status capture.capture_status NOT NULL DEFAULT 'queued',

    -- Classification (async Haiku pass or deterministic URL-only shortcut)
    -- {type, confidence, title, rationale, classifier, model?, links?[]}
    classification JSONB,
    classified_at TIMESTAMPTZ,
    classify_attempts INTEGER NOT NULL DEFAULT 0,

    -- Routing
    route_destination TEXT,               -- executor name: tana-inbox | references | review
    route_attempts INTEGER NOT NULL DEFAULT 0,
    routed_at TIMESTAMPTZ,
    route_result JSONB,                   -- executor receipt (e.g. tana response, reference key)

    -- Error tracking (separate from status so state is preserved on failure)
    last_error TEXT,
    last_error_at TIMESTAMPTZ,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_captures_status ON capture.captures(status);
CREATE INDEX idx_captures_captured_at ON capture.captures(captured_at DESC);
CREATE INDEX idx_captures_queued ON capture.captures(captured_at)
    WHERE status = 'queued';
CREATE INDEX idx_captures_routable ON capture.captures(captured_at)
    WHERE status IN ('classified', 'awaiting_executor');
CREATE INDEX idx_captures_review ON capture.captures(captured_at DESC)
    WHERE status = 'awaiting_review';

CREATE OR REPLACE FUNCTION capture.update_captures_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER captures_updated_trigger
  BEFORE UPDATE ON capture.captures
  FOR EACH ROW EXECUTE FUNCTION capture.update_captures_updated_at();
