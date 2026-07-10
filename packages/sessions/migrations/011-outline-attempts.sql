-- Sessions Module: Outline retry cap
--
-- Tracks failed outline-generation attempts per session so the automatic
-- sweeps (hourly sessions:generate-outlines cron + the post-sync/post-push
-- triggers) can stop retrying a session that fails repeatedly (e.g. one
-- whose transcript is too large for Haiku's context window even after
-- capping) instead of burning a paid Haiku call every 5-minute cycle
-- forever. Reset to 0 on a successful outline; incremented on each failure.
-- A manual retry naming specific session ids bypasses the cap.

ALTER TABLE sessions.sessions
    ADD COLUMN outline_attempts INTEGER NOT NULL DEFAULT 0;

-- Speeds up the "pending, not yet capped" query the outline sweeps run.
CREATE INDEX idx_sessions_outline_attempts
    ON sessions.sessions(outline_attempts)
    WHERE outline_hash IS DISTINCT FROM transcript_hash;
