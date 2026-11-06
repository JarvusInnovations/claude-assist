-- Clean sync instant (specs/behaviors/session-engagement.md: "Source
-- freshness"): the start of the machine's most recent push, local sync or
-- inventory check that finished with every session ingested and no errors.
-- `last_sync_at` keeps its meaning (the last cycle of any outcome).
ALTER TABLE sessions.machines ADD COLUMN last_clean_sync_at TIMESTAMPTZ;
