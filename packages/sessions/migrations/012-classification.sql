-- Session classification — the self-improvement loop's foundation (#session-classification).
--
-- Three tables:
--   * classification_cursors  — one row per session; a per-session incremental
--     cursor (last classified message seq) so a long-running session that
--     re-ingests as it evolves only pays to classify the delta each cycle.
--   * classification_events   — APPEND-ONLY typed events detected over each new
--     message window (correction / friction / rule-candidate / notable-decision).
--     Never updated or rewritten; the weekly synthesis digests them.
--   * synthesis_reports       — the weekly Sonnet synthesis + timeline narrative,
--     persisted (and also delivered via the notify digest).

-- ── Per-session incremental cursor ──────────────────────────────────────────
-- last_seq is the highest message index (aligned with tool_calls.msg_index and
-- the transcript parse ordering) that has been classified. last_hash mirrors the
-- outline_hash pattern: a session is re-selected only when its transcript_hash
-- differs, and classification resumes from last_seq — delta-only.
CREATE TABLE sessions.classification_cursors (
    session_id       UUID PRIMARY KEY REFERENCES sessions.sessions(id) ON DELETE CASCADE,
    last_seq         INTEGER NOT NULL DEFAULT -1,   -- -1 = nothing classified yet
    last_hash        VARCHAR(32),                   -- transcript_hash at last classification
    message_count    INTEGER NOT NULL DEFAULT 0,    -- parsed message count at last classification
    -- Set once a session has gone quiet (>48h since last activity) and had its
    -- terminal classification pass. Stops it being re-checked forever.
    final_pass_done  BOOLEAN NOT NULL DEFAULT FALSE,
    -- Failed classification attempts; the sweep stops selecting a session past a
    -- cap (mirrors outline_attempts) so a permanently-broken session can't burn
    -- a paid Haiku call every cycle. Reset to 0 by a successful pass.
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_classified_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Append-only classification events ───────────────────────────────────────
CREATE TABLE sessions.classification_events (
    id          BIGSERIAL PRIMARY KEY,
    session_id  UUID NOT NULL REFERENCES sessions.sessions(id) ON DELETE CASCADE,
    -- The message-index range of the delta window this event was detected in.
    seq_start   INTEGER NOT NULL,
    seq_end     INTEGER NOT NULL,
    event_type  TEXT NOT NULL CHECK (event_type IN (
                  'correction', 'friction', 'rule-candidate', 'notable-decision')),
    summary     TEXT NOT NULL,          -- one-line description
    confidence  REAL NOT NULL DEFAULT 0.5,
    quote       TEXT,                   -- verbatim snippet from the transcript
    model       TEXT,                   -- classifier model id
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_classification_events_session ON sessions.classification_events (session_id, seq_start);
CREATE INDEX idx_classification_events_type ON sessions.classification_events (event_type);
-- Weekly synthesis scans a recent window ordered by recency.
CREATE INDEX idx_classification_events_created ON sessions.classification_events (created_at DESC);

-- ── Weekly synthesis + narrative reports ────────────────────────────────────
CREATE TABLE sessions.synthesis_reports (
    id            BIGSERIAL PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('synthesis', 'narrative')),
    period_start  DATE NOT NULL,
    period_end    DATE NOT NULL,
    report        TEXT NOT NULL,        -- rendered markdown
    report_json   JSONB,                -- structured payload (synthesis: proposals + hotspots)
    event_count   INTEGER NOT NULL DEFAULT 0,
    model         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Re-running a week's job replaces that week's report rather than duplicating.
    UNIQUE (kind, period_start)
);

CREATE INDEX idx_synthesis_reports_period ON sessions.synthesis_reports (period_start DESC);
