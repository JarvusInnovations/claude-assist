-- Kitchen Module: Strava OAuth token custody (specs/modules/kitchen.md
-- § Strava activity sync, claude-assist#121).
--
-- Strava rotates the refresh token on every refresh, so a static env var
-- cannot stay authoritative. This single row holds the CURRENT token set;
-- the KITCHEN_STRAVA_REFRESH_TOKEN env value is the first-boot seed only —
-- once this row exists, the stored token is authoritative and the env value
-- is ignored (delete the row to re-seed after a revocation). Nothing ever
-- deletes this row automatically: a refresh failure skips the sync tick and
-- retries next tick (transient Strava outages must not force a re-auth).

CREATE TABLE IF NOT EXISTS kitchen.strava_oauth (
    -- Single-row table: the id is pinned to 1.
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    refresh_token TEXT NOT NULL,
    access_token TEXT,
    expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
