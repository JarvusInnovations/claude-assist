-- Google Module: two-tier email urgency — the ATTENTION store.
--
-- The email urgency pipeline (services/urgency-pipeline.ts) sorts triaged mail
-- into two explicit, model-legible tiers, per the "interrupts are earned"
-- principle:
--
--   INTERRUPT — "bad if unseen for an hour": a known human, an ask directed at
--               the owner, and an inferred blocking / time-sensitive signal.
--               Fires a wrist-reaching interrupt through the notify dispatcher.
--   ATTENTION — "bad if unseen until tomorrow": a concrete ask addressed to the
--               owner, or substantive mail from an individual client contact.
--               Never interrupts; surfaces in the morning briefing.
--
-- This table is the durable home for both tiers (mirrors slack_urgency.candidates
-- + its near_misses view). The daily-briefing "Needs attention" section reads it
-- by name, replacing its old alerted_at-only source. `email_id` is the
-- idempotency key so a re-triage upserts one row per email.
--
-- Quiet hours: an INTERRUPT candidate raised inside the owner's quiet window is
-- HELD (interrupted=false, quiet_held=true) rather than dispatched, and shown
-- prominently in the morning briefing. A genuine emergency inference pierces
-- quiet hours and interrupts anyway.

CREATE TABLE google.email_attention (
    -- One row per email; a re-triage upserts (idempotent).
    email_id        INTEGER PRIMARY KEY REFERENCES google.emails(id) ON DELETE CASCADE,
    account_id      INTEGER REFERENCES google.accounts(id) ON DELETE CASCADE,

    -- Judgment
    tier            TEXT NOT NULL,          -- interrupt | attention
    verdict         TEXT NOT NULL,          -- interrupt | attention | quiet_held
    classifier      TEXT NOT NULL,          -- deterministic | model
    model           TEXT,                   -- model id when classifier='model'
    reason          TEXT,                   -- one-line explanation (why this tier)
    gist            TEXT,                   -- short summary carried into the briefing
    signals         TEXT[] NOT NULL DEFAULT '{}',
    confidence      REAL,

    -- Denormalized sender/subject so the briefing renders without re-joining.
    from_name       TEXT,
    from_address    TEXT,
    subject         TEXT,
    overview        TEXT,

    -- Opportunity (RFP/solicitation) evaluation, when this reached the tier via
    -- the owner-interest opportunity path rather than the ordinary ask gates.
    opportunity_match     BOOLEAN NOT NULL DEFAULT FALSE,
    opportunity_high      BOOLEAN NOT NULL DEFAULT FALSE,  -- watchlist-style hit

    -- Delivery
    interrupted     BOOLEAN NOT NULL DEFAULT FALSE,        -- an interrupt actually dispatched
    quiet_held      BOOLEAN NOT NULL DEFAULT FALSE,        -- interrupt held for quiet hours
    notification_id INTEGER,                               -- notify.notifications.id when it interrupted

    message_date    TIMESTAMPTZ,            -- the email's own date (for ordering)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_email_attention_account ON google.email_attention(account_id);
CREATE INDEX idx_email_attention_date ON google.email_attention(message_date DESC);
CREATE INDEX idx_email_attention_quiet_held ON google.email_attention(message_date DESC)
    WHERE quiet_held;

-- Keep updated_at fresh on upsert.
CREATE OR REPLACE FUNCTION google.update_email_attention_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER email_attention_updated_trigger
  BEFORE UPDATE ON google.email_attention
  FOR EACH ROW EXECUTE FUNCTION google.update_email_attention_updated_at();
