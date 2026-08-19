-- Context-window occupancy per session (specs/behaviors/session-context-window.md).
--
-- Distinct from the existing token columns: those are lifetime SUMS across every
-- API call, these are the size of a SINGLE call's prompt. Nullable throughout --
-- null means "not measured" (no main-chain usage, or a model absent from the
-- limit table), which the UI renders as no bar rather than as 0%.

ALTER TABLE sessions.sessions
  ADD COLUMN context_final_tokens INTEGER,   -- prompt size on the last main-chain call
  ADD COLUMN context_peak_tokens  INTEGER,   -- largest prompt size observed
  ADD COLUMN context_limit_tokens INTEGER,   -- window of the model that served the last call
  ADD COLUMN context_model        VARCHAR(100),
  -- Stamped by the backfill so a session that is legitimately unmeasurable
  -- (no main-chain usage, unparseable transcript) is not rescanned forever.
  ADD COLUMN context_backfilled_at TIMESTAMPTZ;

-- Backfill is done in the application (see SyncService.backfillContextWindow):
-- it re-parses raw_transcript, which SQL cannot do.
