-- Retire the inline raw_transcript column (specs/behaviors/
-- session-transcript-storage.md; plans/retire-raw-transcript.md). Chunks
-- become the only transcript storage: every session must already be
-- `storage = 'chunked'` with a null `raw_transcript` by the time this runs —
-- the production backfill (migration 016 / the chunk-backfill task) is
-- responsible for getting every row there BEFORE this migration is deployed.
--
-- This file is only safe to ship once that backfill has converged
-- (`GET /sessions/backfill/status` reporting remaining=0, failures=0). It
-- does not trust that claim: the DO block below re-checks the database
-- itself and aborts the whole migration (one transaction — see
-- packages/core/src/migrations.ts, which wraps every migration file in
-- `sql.begin`) if the precondition doesn't hold, so a premature deploy fails
-- loudly and leaves the schema completely untouched rather than silently
-- losing whichever rows hadn't converted yet. The migration remains pending
-- (never recorded in schema_migrations) after an abort, so simply finishing
-- the backfill and re-running migrations picks it back up.

DO $$
DECLARE
  unconverted_count BIGINT;
  pending_failures BIGINT;
BEGIN
  SELECT COUNT(*) INTO unconverted_count
  FROM sessions.sessions
  WHERE raw_transcript IS NOT NULL OR storage <> 'chunked';

  IF unconverted_count > 0 THEN
    RAISE EXCEPTION
      'retire-raw-transcript: % session(s) are not yet fully chunked (raw_transcript IS NOT NULL or storage <> ''chunked''). Finish the legacy-transcript chunk backfill (sessions-axi backfill status / GET /sessions/backfill/status must report remaining=0, failures=0) before deploying this migration.',
      unconverted_count;
  END IF;

  SELECT COUNT(*) INTO pending_failures FROM sessions.backfill_failures;

  IF pending_failures > 0 THEN
    RAISE EXCEPTION
      'retire-raw-transcript: % row(s) remain in sessions.backfill_failures. Every backfill failure must be resolved (converted or otherwise accounted for) before this migration can drop that table.',
      pending_failures;
  END IF;
END $$;

ALTER TABLE sessions.sessions
  DROP COLUMN raw_transcript,
  DROP COLUMN storage,
  DROP COLUMN catchup_threshold_bytes,
  DROP COLUMN backfill_owned;

DROP TABLE sessions.backfill_failures;
