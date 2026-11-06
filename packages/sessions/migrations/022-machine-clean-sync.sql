-- Clean sync instant (specs/behaviors/session-engagement.md: "Source
-- freshness"): the latest moment the server knew it held everything the
-- machine had written (a clean local sync, or an inventory that needs nothing).
-- `last_sync_at` keeps its meaning (the last cycle of any outcome).
ALTER TABLE sessions.machines ADD COLUMN last_clean_sync_at TIMESTAMPTZ;
