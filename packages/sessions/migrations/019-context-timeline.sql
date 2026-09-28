-- Session context timeline (specs/behaviors/session-context-window.md's
-- "Timeline" section). Schema only — no backfill here; migrations run inside
-- Fastify plugin startup under a 10s timeout (ca#248), so anything that would
-- touch existing rows in bulk belongs in the background backfill task
-- (packages/sessions/src/timeline-backfill.ts), not a migration.
--
-- One reading per main-chain API call, one event per compact_boundary line —
-- append-only, never rewritten (mirrors tool_calls: see
-- specs/behaviors/session-transcript-storage.md).
CREATE TABLE sessions.context_events (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions.sessions(id) ON DELETE CASCADE,
  -- The message's ordinal position (matches transcript_messages.seq) — what
  -- lets live ingest and the backfill task agree on what has already been
  -- recorded without re-deriving from scratch, and gives the (session_id,
  -- seq, kind) unique index below its idempotency meaning.
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reading', 'compaction')),
  ts TIMESTAMPTZ,
  -- 'reading' only: the context token count for that call.
  tokens INTEGER,
  -- 'compaction' only: the transcript's compact_boundary fields.
  trigger TEXT,
  pre_tokens INTEGER,
  post_tokens INTEGER,
  UNIQUE (session_id, seq, kind)
);

CREATE INDEX idx_context_events_session_ts
  ON sessions.context_events (session_id, ts);

-- Resumable backfill bookkeeping for sessions ingested before this feature
-- existed (specs/behaviors/session-context-window.md: "Existing sessions are
-- backfilled"). `timeline_backfill_done` is the live-ingest/backfill handoff
-- flag: a session that was never touched by pre-timeline code (freshly
-- INSERTed after this migration) starts `true` — there is no backlog to
-- backfill, so live ingest may write context_events from its very first
-- cycle. An existing session starts `false`; the backfill task walks its
-- already-stored transcript_chunks from `timeline_backfill_next_chunk_seq`
-- forward, one chunk at a time, using its own independent incremental-parser
-- checkpoint (`timeline_backfill_checkpoint` — distinct from the live-ingest
-- `parse_checkpoint`, since the two walk the chunk series at different
-- paces), and flips the flag once no chunk remains beyond its cursor. See
-- packages/sessions/src/chunk-store.ts and timeline-backfill.ts for the
-- row-lock ordering that keeps the handoff race-free.
ALTER TABLE sessions.sessions
  ADD COLUMN timeline_backfill_done BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN timeline_backfill_next_chunk_seq INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN timeline_backfill_checkpoint JSONB;
