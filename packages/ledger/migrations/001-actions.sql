-- Audit ledger: the normalized "what did the system do on my behalf" surface.
--
-- One row per external action, from exactly two sources (see the audit-ledger
-- spec):
--   - derived — a deterministic, versioned ruleset classifies external actions
--     out of already-ingested session tool calls (sessions.tool_calls), after
--     the fact. Derived rows are an INDEX over the transcript corpus, not a
--     second copy of truth; improving the ruleset re-derives the whole history.
--   - direct  — transcript-less services (email executor, notification
--     dispatcher, future automation) write a row at execution time. For these
--     actors the ledger row IS the record.
--
-- Both sources share this one schema and one query surface.

CREATE SCHEMA IF NOT EXISTS ledger;

CREATE TABLE ledger.actions (
    id            BIGSERIAL PRIMARY KEY,
    ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- when the action happened
    actor         JSONB NOT NULL,                       -- {kind:'session'|'service'|'agent', session_id?, sidechain?, service?}
    action_type   TEXT NOT NULL,                        -- broad class: outbound | repo-write | team-record-write | email-action | ...
    target_system TEXT NOT NULL,                        -- github | git | hq | email | calendar | slack | notification | gmail | ...
    target_id     TEXT,                                 -- identifier within the target system, when there is one
    summary       TEXT NOT NULL,                        -- one-line human summary
    context       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- pointer to richer context: {tool_call_id, session_id, msg_uuid} | {email_id, ...}
    source        TEXT NOT NULL CHECK (source IN ('derived', 'direct')),
    rules_version TEXT,                                 -- extraction ruleset version (derived rows only; NULL for direct)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Derived rows are an index over tool_calls: at most one row per
-- (tool_call, rules_version). Re-running the derivation with the same version
-- is idempotent (ON CONFLICT DO NOTHING). Direct rows are excluded from the
-- constraint entirely (they carry no tool_call_id / rules_version).
CREATE UNIQUE INDEX uq_actions_derived_tool_call
    ON ledger.actions ((context ->> 'tool_call_id'), rules_version)
    WHERE source = 'derived';

-- Query-surface indexes: newest-first listing, plus type/source filtering.
CREATE INDEX idx_actions_ts ON ledger.actions (ts DESC);
CREATE INDEX idx_actions_type ON ledger.actions (action_type);
CREATE INDEX idx_actions_source ON ledger.actions (source);

-- Singleton derivation cursor: which rules_version is currently materialized
-- and how far through sessions.tool_calls (by ascending id) the incremental
-- pass has consumed. A version mismatch at boot triggers a full re-derivation.
CREATE TABLE ledger.derivation_state (
    id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    rules_version     TEXT NOT NULL,
    last_tool_call_id BIGINT NOT NULL DEFAULT 0,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
