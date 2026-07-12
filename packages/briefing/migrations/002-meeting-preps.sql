-- Briefing / Per-Meeting Briefings (Preps)
--
-- One durable table behind the per-meeting briefing cycle. Unlike the daily
-- briefing (a stateless morning render), a prep accumulates across the gap
-- between occurrences — rolling captures fold in, a 24h-ahead pass refreshes
-- it — so it needs a home.
--
--   meeting_preps — one row per meeting OCCURRENCE, keyed by the calendar
--                   instance id (series + original-start suffix). That key is
--                   reschedule-stable: Google keeps the suffix anchored to the
--                   original start when an occurrence moves, so a rescheduled
--                   meeting keeps its prep instead of spawning a duplicate.
--                   occurrence_start tracks the actual (moved) start.
--
-- status lifecycle: draft (composed) → delivered (rendered into Tana) →
-- refreshed (re-composed with newer inputs after delivery and re-rendered).
-- inputs_digest is a hash of the inputs the current content was composed from,
-- so a refresh pass skips a redundant model call + re-render when nothing
-- changed.

CREATE TABLE briefing.meeting_preps (
    -- Calendar instance id (recurrence suffix included): unique per occurrence,
    -- stable across reschedules.
    occurrence_key    TEXT PRIMARY KEY,
    -- Base recurring-event id (suffix stripped); equals occurrence_key for one-offs.
    series_key        TEXT NOT NULL,
    -- Actual (possibly rescheduled) occurrence start.
    occurrence_start  TIMESTAMPTZ,
    summary           TEXT,

    status            TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'refreshed', 'delivered')),

    -- The composed prep artifact (Tana-paste-ready outline).
    prep_content      TEXT,
    -- Hash of the inputs the current content was composed from.
    inputs_digest     TEXT,
    -- Model id that composed it, or 'deterministic' when no model was wired.
    model             TEXT,
    -- Tana node the prep was rendered into (link-out + idempotent re-render).
    delivered_node_id TEXT,

    generated_at      TIMESTAMPTZ,
    refreshed_at      TIMESTAMPTZ,
    delivered_at      TIMESTAMPTZ,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_meeting_preps_series ON briefing.meeting_preps(series_key);
-- Drives the 24h-ahead refresh pass (upcoming occurrences by start).
CREATE INDEX idx_meeting_preps_start ON briefing.meeting_preps(occurrence_start);

CREATE OR REPLACE FUNCTION briefing.touch_meeting_prep_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER meeting_preps_touch
  BEFORE UPDATE ON briefing.meeting_preps
  FOR EACH ROW EXECUTE FUNCTION briefing.touch_meeting_prep_updated_at();
