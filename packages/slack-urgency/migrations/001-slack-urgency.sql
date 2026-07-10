-- Slack urgency module: a read-only listener over Chris's incoming Slack that
-- fires wrist-reaching interrupts ONLY for what genuinely can't wait (a blocked
-- teammate, a time-sensitive request, an explicit ask waiting on Chris) per the
-- "interrupts are earned" principle. Everything else batches to the digest.
--
-- Ingestion is a poll loop over a USER token (reads AS the owner): the chat
-- bot's socket only sees its own DMs/mentions, never the owner's personal DMs from
-- teammates. Per-conversation cursors make each poll incremental (rate-limit
-- friendly). This module NEVER posts, reacts, or marks-read anything.
--
-- Homes (one home per datum):
--   candidates  — every message that cleared the deterministic pre-pass (a
--                 directed teammate message); the durable record of what was
--                 seen, how it was judged, and whether it interrupted.
--   cursors     — per-conversation poll position (last seen slack ts).
--   weights     — per-sender / per-channel correction signal (the one-tap
--                 "should / shouldn't have interrupted" feedback).
--   near_misses — a VIEW over candidates (a rendering, not a home) that the
--                 daily-briefing pipeline reads as its false-negative backstop.

CREATE TABLE slack_urgency.candidates (
    -- Slack's channel+ts is globally unique and stable → the idempotency key.
    -- Slack's at-least-once delivery / overlapping polls collapse to one row.
    channel        TEXT NOT NULL,
    ts             TEXT NOT NULL,          -- slack message ts ("1720620000.001200")
    PRIMARY KEY (channel, ts),

    thread_ts      TEXT,                   -- parent ts when in a thread (else NULL)
    channel_type   TEXT NOT NULL,          -- im | mpim | channel | group
    sender         TEXT NOT NULL,          -- slack user id of the author
    sender_name    TEXT,                   -- resolved display name (best effort)
    text           TEXT NOT NULL,
    permalink      TEXT,                   -- https permalink (deep link in the alert)

    -- Judgment
    tier           TEXT NOT NULL,          -- emergency | urgent | residue | drop
    verdict        TEXT NOT NULL,          -- interrupt | near_miss | folded | suppressed | drop
    classifier     TEXT NOT NULL,          -- deterministic | model
    model          TEXT,                   -- model id when classifier='model'
    gist           TEXT,                   -- one-line summary carried in the alert
    signals        TEXT[] NOT NULL DEFAULT '{}',  -- deterministic signals that fired
    rationale      TEXT,
    confidence     REAL,

    interrupted    BOOLEAN NOT NULL DEFAULT FALSE,
    near_miss      BOOLEAN NOT NULL DEFAULT FALSE,  -- plausible-but-not-fired → digest backstop
    notification_id INTEGER,               -- notify.notifications.id when it interrupted

    message_ts     TIMESTAMPTZ NOT NULL,   -- slack ts as a real timestamp (sender's clock)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_su_candidates_thread ON slack_urgency.candidates(channel, thread_ts)
    WHERE interrupted;
CREATE INDEX idx_su_candidates_near_miss ON slack_urgency.candidates(message_ts DESC)
    WHERE near_miss;
CREATE INDEX idx_su_candidates_created ON slack_urgency.candidates(created_at DESC);

-- Per-conversation poll cursor. `last_seen_ts` is the newest slack ts already
-- pulled from this conversation; the next poll passes it as `oldest` so only
-- new messages come back. First sight of a conversation seeds the cursor to
-- "now" (no historical backfill → no alert storm on first boot).
CREATE TABLE slack_urgency.cursors (
    conversation_id TEXT PRIMARY KEY,      -- channel/dm id
    last_seen_ts    TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Correction signal. The one-tap correction endpoint nudges a weight per sender
-- or per channel; the deterministic core reads it to promote/demote borderline
-- (residue) verdicts. Positive → lean toward interrupting; negative → away.
CREATE TABLE slack_urgency.weights (
    scope       TEXT NOT NULL CHECK (scope IN ('sender', 'channel')),
    key         TEXT NOT NULL,             -- slack user id (sender) or channel id
    weight      REAL NOT NULL DEFAULT 0,
    corrections INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (scope, key)
);

-- Near-miss backstop, exposed as a stable read surface for the daily-briefing
-- pipeline (a separate branch). It queries this by name; the column contract
-- below is the coordination point — do not repurpose these columns.
CREATE VIEW slack_urgency.near_misses AS
    SELECT channel,
           ts,
           thread_ts,
           channel_type,
           sender,
           sender_name,
           text,
           permalink,
           tier,
           gist,
           rationale,
           confidence,
           message_ts,
           created_at
    FROM slack_urgency.candidates
    WHERE near_miss
    ORDER BY message_ts DESC;
