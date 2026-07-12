-- Capture Module: meeting-series routing metadata
--
-- Per-meeting briefings fold "rolling agenda captures" into the next
-- occurrence's prep (see the meeting-briefings pipeline in the briefing
-- package). A capture is associated with a recurring meeting by its stable
-- calendar SERIES key (the base recurring-event id, instance suffix stripped).
--
-- Two association paths, both read by the briefing's meeting-captures source:
--
--   1. meeting_series_key column — the explicit routing field. Server-side
--      capture routing (capture-service's concern) sets this when it decides a
--      capture belongs to a meeting series. Nullable: most captures aren't
--      meeting-scoped.
--
--   2. a `meeting:<series_key>` tag in the existing tags[] array — the
--      convention a client or ad-hoc tagger can use TODAY without any
--      capture-service change. Equivalent to setting the column.
--
-- The column stays dumb (a routing tag, not a foreign key): the capture
-- endpoint remains "dumber than routing", and the briefing owns interpretation.

ALTER TABLE capture.captures
    ADD COLUMN meeting_series_key TEXT;

-- Partial index: only meeting-routed captures, for the briefing's per-series read.
CREATE INDEX idx_captures_meeting_series
    ON capture.captures(meeting_series_key, captured_at DESC)
    WHERE meeting_series_key IS NOT NULL;
