-- Chapter rollups for windowed outlines (specs/behaviors/session-outlines.md,
-- "Rollups" section). Composing every window summary in one call does not
-- scale: a multi-week session reaches hundreds of windows, and the combined
-- summaries exceed the model's input. Rollups form a summary-of-summaries
-- hierarchy with fan-in SESSIONS_OUTLINE_ROLLUP_FANIN so the compose input
-- stays bounded at any session length. Schema only - no backfill (migrations
-- run inside a 10s plugin-startup timeout, ca#248); an existing large
-- session picks up rollups on its next outline sweep like any other config
-- change. Independent of migrations 014/015 - no shared objects, no
-- ordering dependency.
--
-- Rollups are closed-by-construction, unlike outline_windows: a row is only
-- ever inserted once every child in its range (windows for level 1, level
-- (n-1) rollups for level n) is closed and resolved (summarized or failed;
-- OutlineRollupStore.planRollupGroups / OutlineService's rollup pass never
-- creates a row for a group that still has a pending/summarizing member).
-- There is no "open tail" rollup - nothing here is ever mutated after
-- insert, so there's no closed_at/immutability guard to write, just the
-- same claim/lease/attempt-cap queue OutlineWindowStore already has, reused
-- to summarize each row exactly once.
CREATE TABLE sessions.outline_rollups (
    id               BIGSERIAL PRIMARY KEY,
    session_id       UUID NOT NULL REFERENCES sessions.sessions(id) ON DELETE CASCADE,
    level            INTEGER NOT NULL,        -- 1 = groups of windows; n = groups of level-(n-1) rollups
    rollup_index     INTEGER NOT NULL,        -- 0-based, monotonic per (session, level) - the k in [k*fanin, (k+1)*fanin)
    from_seq         INTEGER NOT NULL,
    to_seq           INTEGER NOT NULL,        -- inclusive; spans its children's combined range
    from_ts          TIMESTAMPTZ,
    to_ts            TIMESTAMPTZ,
    status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'summarizing', 'summarized', 'failed')),
    summary          TEXT,
    content_hash     VARCHAR(32),             -- hash of the children's summaries at creation
    model            TEXT,                    -- summarizer model id
    attempts         INTEGER NOT NULL DEFAULT 0,
    lease_owner      TEXT,
    lease_expires_at TIMESTAMPTZ,
    last_error       TEXT,
    summarized_at    TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (session_id, level, rollup_index)
);

-- The claim query's selection predicate (mirrors idx_outline_windows_pending).
CREATE INDEX idx_outline_rollups_pending
    ON sessions.outline_rollups (session_id, level, rollup_index)
    WHERE status = 'pending';

-- Reclaiming expired leases (mirrors idx_outline_windows_leased).
CREATE INDEX idx_outline_rollups_leased
    ON sessions.outline_rollups (lease_expires_at)
    WHERE status = 'summarizing';
