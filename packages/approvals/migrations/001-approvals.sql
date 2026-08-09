-- Human-approval gates (specs/modules/approvals.md).
--
-- One row per request that needs a person. The module knows nothing about what
-- is being approved: kind, title, body, and payload are caller data.
--
-- The rule this table exists to serve is that no code path ever blocks waiting
-- for a human. A requester writes a row, a notification goes out, and the
-- requester returns. Resolution is a separate, later event.

CREATE SCHEMA IF NOT EXISTS approvals;

CREATE TABLE approvals.requests (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind          TEXT NOT NULL,                          -- caller-defined class
    requested_by  TEXT NOT NULL,                          -- module or task that raised it
    title         TEXT NOT NULL,
    body          TEXT NOT NULL,
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb,     -- what the requester needs back
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','denied','expired','cancelled')),
    dedupe_key    TEXT,
    resolution    JSONB,                                  -- {decision, note?, params?}
    resolved_by   TEXT,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at   TIMESTAMPTZ
);

-- Deduplication is a partial unique index over PENDING rows only, not a
-- remembered flag: a sweep that hits the same wall every minute must not
-- notify every minute, and the same key must be raisable again once the
-- previous request has been resolved or has expired.
CREATE UNIQUE INDEX approvals_one_pending_per_key
    ON approvals.requests (dedupe_key)
    WHERE status = 'pending' AND dedupe_key IS NOT NULL;

CREATE INDEX idx_approvals_pending ON approvals.requests (created_at DESC)
    WHERE status = 'pending';
CREATE INDEX idx_approvals_expiring ON approvals.requests (expires_at)
    WHERE status = 'pending';
CREATE INDEX idx_approvals_key_resolved ON approvals.requests (dedupe_key, resolved_at DESC)
    WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_approvals_kind ON approvals.requests (kind, created_at DESC);
