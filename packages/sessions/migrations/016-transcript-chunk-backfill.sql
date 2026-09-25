-- Legacy-transcript backfill (specs/behaviors/session-transcript-storage.md,
-- plans/transcript-chunk-backfill.md). Converts existing storage = 'inline'
-- rows to chunks FROM THE DATABASE COPY (raw_transcript), since many of these
-- sessions no longer exist on disk.
--
-- Two additions:
--
-- 1. `backfill_owned` distinguishes a `catching_up` row the BACKFILL put there
--    (source: raw_transcript, byte ranges read via SQL) from one local sync
--    put there (source: the on-disk file, an inline row whose file grew — see
--    SyncService#ingestLocalFile). Both use the same `storage = 'catching_up'`
--    state and the same `catchup_threshold_bytes` column, but only a
--    backfill-owned row is safe for the backfill task to resume across its own
--    runs: resuming a local-sync-owned row would mean the backfill starts
--    reading byte ranges out of raw_transcript that local sync's cycles were
--    never guaranteed to keep aligned with (local sync reads its bytes from
--    the file, not raw_transcript). The backfill's candidate queries always
--    filter on `backfill_owned = TRUE` for continuation, so a local-sync-owned
--    catching_up row is left alone — exactly the "skip rows local sync already
--    moved to catching_up" rule in the plan. Left TRUE permanently once a
--    session flips to 'chunked' by the backfill's own hand, as a cheap
--    "was this one backfilled" marker for the status endpoint.
ALTER TABLE sessions.sessions
  ADD COLUMN backfill_owned BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. A row that fails the pre-flip verification (reassembled chunks don't
--    match raw_transcript's length+hash) is reverted to 'inline' rather than
--    left half-converted, and recorded here so the next run doesn't retry it
--    forever. `attempts`/`last_error` give an operator a queryable answer to
--    "why did this stop" instead of an archaeology expedition (specs/
--    principles.md: "Alert on the absence of success").
CREATE TABLE sessions.backfill_failures (
  session_id UUID PRIMARY KEY REFERENCES sessions.sessions(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
