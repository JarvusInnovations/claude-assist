-- Windowed outlines for long-running sessions (specs/behaviors/session-outlines.md).
--
-- A session over the outline threshold is carved into windows by message
-- range, each summarized once when closed; the session outline is composed
-- from the window summaries instead of a single truncated pass over the
-- whole transcript. Independent of migration 014 (transcript-chunked-ingest):
-- no shared objects, no ordering dependency between the two.

-- ── Windows ──────────────────────────────────────────────────────────────
-- One row per window. `closed_at IS NULL` marks the open tail window — the
-- only row for a session that may still change; every row with `closed_at`
-- set is immutable from then on (from_seq/to_seq/from_ts/to_ts/closed_at
-- never change again — see OutlineWindowStore.upsertBoundary's guard).
--
-- `status`/`attempts`/`lease_owner`/`lease_expires_at`/`last_error` are the
-- claim/lease columns for the summarization queue (OutlineWindowStore),
-- deliberately hand-rolled rather than packages/core's generic
-- createLeaseQueue — see the comment on OutlineWindowStore for why.
CREATE TABLE sessions.outline_windows (
    id               BIGSERIAL PRIMARY KEY,
    session_id       UUID NOT NULL REFERENCES sessions.sessions(id) ON DELETE CASCADE,
    window_index     INTEGER NOT NULL,        -- 0-based, monotonic per session
    from_seq         INTEGER NOT NULL,
    to_seq           INTEGER NOT NULL,        -- inclusive; grows in place while open
    from_ts          TIMESTAMPTZ,
    to_ts            TIMESTAMPTZ,
    closed_at        TIMESTAMPTZ,             -- NULL = open tail window
    status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'summarizing', 'summarized', 'failed')),
    summary          TEXT,
    content_hash     VARCHAR(32),             -- hash of the window's content at last summarization
    model            TEXT,                    -- summarizer model id
    attempts         INTEGER NOT NULL DEFAULT 0,
    lease_owner      TEXT,
    lease_expires_at TIMESTAMPTZ,
    last_error       TEXT,
    summarized_at    TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (session_id, window_index)
);

-- The global claim query's selection predicate.
CREATE INDEX idx_outline_windows_pending
    ON sessions.outline_windows (closed_at, session_id, window_index)
    WHERE status = 'pending';

-- Reclaiming expired leases.
CREATE INDEX idx_outline_windows_leased
    ON sessions.outline_windows (lease_expires_at)
    WHERE status = 'summarizing';

-- ── Session-level composition signature ─────────────────────────────────
-- Set once the composed outline reflects the session's current window
-- summaries. Distinct from outline_hash (which tracks the single-pass path
-- against transcript_hash): a windowed session's transcript_hash keeps
-- changing while it's active, but the composed outline should only be
-- regenerated when a window actually closes or the tail summary changes —
-- this is what lets that comparison happen without re-hashing every window
-- summary's text on every sweep just to check.
ALTER TABLE sessions.sessions
    ADD COLUMN outline_windows_hash VARCHAR(32);
