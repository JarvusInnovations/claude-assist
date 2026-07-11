-- Briefing / Meeting-Alerts Module
--
-- Two durable tables behind the join-required alert pipeline:
--
--   series_overrides  — the one-tap correction path. Keyed by the recurring-event
--                       base id (instance suffix stripped) so a correction sticks
--                       across every future occurrence. suppress = never alert,
--                       force = always alert; optional custom lead time.
--
--   alert_dispatches  — the dedup ledger. Exactly one alert fires per qualifying
--                       occurrence (unique on the instance event_id); a restart
--                       mid-day re-reads this and never double-fires.
--
-- The daily briefing and per-meeting briefings are stateless renderings and keep
-- no tables of their own (one home per datum) — the briefing reads live from
-- calendar + commitments + email + the heartbeat registry each morning.

CREATE TABLE briefing.series_overrides (
    series_id     TEXT PRIMARY KEY,
    action        TEXT NOT NULL CHECK (action IN ('suppress', 'force')),
    -- null → use the venue default (3 min video / 15 min physical)
    lead_minutes  INTEGER,
    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE briefing.alert_dispatches (
    -- The calendar instance id (recurrence suffix included): unique per occurrence.
    event_id      TEXT PRIMARY KEY,
    series_id     TEXT NOT NULL,
    summary       TEXT,
    -- When the alert was scheduled to fire and when it actually dispatched.
    fire_at       TIMESTAMPTZ NOT NULL,
    dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- FK-free soft link to notify.notifications(id) for traceability.
    notify_id     INTEGER
);

CREATE INDEX idx_alert_dispatches_series ON briefing.alert_dispatches(series_id);
CREATE INDEX idx_alert_dispatches_fire_at ON briefing.alert_dispatches(fire_at DESC);

CREATE OR REPLACE FUNCTION briefing.touch_series_override_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER series_overrides_touch
  BEFORE UPDATE ON briefing.series_overrides
  FOR EACH ROW EXECUTE FUNCTION briefing.touch_series_override_updated_at();
