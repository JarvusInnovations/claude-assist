-- Prompt events (specs/behaviors/session-engagement.md). Schema only — the
-- backlog is derived by the background backfill task
-- (packages/sessions/src/prompt-backfill.ts), not here (see ca#248).
--
-- One row per user turn with text and per queued prompt: the facts the
-- transcript states about the turn. Whether a turn is human or automated is
-- decided when engagement is read, never stored. Append-only (mirrors
-- context_events).
CREATE TABLE sessions.prompt_events (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions.sessions(id) ON DELETE CASCADE,
  -- The message's ordinal position (matches transcript_messages.seq).
  seq INTEGER NOT NULL,
  -- The message's uuid. A resumed or forked session carries copies of earlier
  -- turns with their original uuid and timestamp; engagement counts a uuid
  -- once (prompt-identity.ts). Null only for lines that carry none.
  uuid TEXT,
  ts TIMESTAMPTZ,
  -- Leading text of the prompt, whitespace-trimmed at the front and bounded
  -- (PROMPT_HEAD_CHARS) — all the classifier ever sees.
  head TEXT NOT NULL,
  is_meta BOOLEAN NOT NULL DEFAULT false,
  is_sidechain BOOLEAN NOT NULL DEFAULT false,
  is_compact_summary BOOLEAN NOT NULL DEFAULT false,
  queued BOOLEAN NOT NULL DEFAULT false,
  -- Authorship fields as the transcript records them (newer client versions
  -- only; null otherwise): origin.kind, promptSource, queuePriority.
  origin_kind TEXT,
  prompt_source TEXT,
  queue_priority TEXT,
  UNIQUE (session_id, seq)
);

CREATE INDEX idx_prompt_events_ts ON sessions.prompt_events (ts);
CREATE INDEX idx_prompt_events_uuid ON sessions.prompt_events (uuid);

-- Live-ingest/backfill handoff bookkeeping — same shape and meaning as the
-- timeline_backfill_* columns added by migration 019. An existing session
-- starts `false`; a session INSERTed after this migration starts `true`.
ALTER TABLE sessions.sessions
  ADD COLUMN prompt_backfill_done BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN prompt_backfill_next_chunk_seq INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN prompt_backfill_checkpoint JSONB;

CREATE INDEX idx_sessions_prompt_backfill_pending
  ON sessions.sessions (id) WHERE prompt_backfill_done = false;
