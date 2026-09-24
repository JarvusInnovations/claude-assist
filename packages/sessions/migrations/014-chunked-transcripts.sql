-- Chunked, incremental transcript storage (specs/behaviors/session-transcript-storage.md).
--
-- Every session gains a storage discriminator, a byte cursor, and a persisted
-- parser checkpoint. New chunk tables hold the append-only archive itself and
-- a per-message index for anchor/range lookups. `raw_transcript` becomes
-- nullable: chunked sessions never populate it. `storage` starts 'inline' for
-- every existing row (nothing is converted here — that is the backfill plan);
-- new rows are inserted with storage='chunked' from the first cycle.

ALTER TABLE sessions.sessions
  ALTER COLUMN raw_transcript DROP NOT NULL;

ALTER TABLE sessions.sessions
  ADD COLUMN storage TEXT NOT NULL DEFAULT 'inline'
    CHECK (storage IN ('inline', 'catching_up', 'chunked')),
  -- How many bytes of the on-disk transcript have been archived (as chunks)
  -- so far. For 'inline' rows this stays 0 (their archive is raw_transcript,
  -- not chunks) until a change on disk moves them to 'catching_up'.
  ADD COLUMN ingested_bytes BIGINT NOT NULL DEFAULT 0,
  -- Opaque incremental-parser state (packages/sessions/src/incremental-parser.ts)
  -- needed to resume aggregation from ingested_bytes without a re-parse.
  ADD COLUMN parse_checkpoint JSONB,
  -- Set when an inline row enters 'catching_up': the raw_transcript length at
  -- the moment catch-up began. raw_transcript is only cleared (and storage
  -- flipped to 'chunked') once ingested_bytes reaches this threshold — the
  -- invariant that a session's complete content is never covered by neither
  -- raw_transcript nor chunks at once.
  ADD COLUMN catchup_threshold_bytes BIGINT;

COMMENT ON COLUMN sessions.sessions.storage IS
  'inline: legacy, content lives in raw_transcript only. catching_up: an inline row whose on-disk file changed; chunks are back-filling from byte 0 while raw_transcript still holds the complete record. chunked: chunks are the only archive; raw_transcript is null.';

-- Append-only archive. A chunk, once written, is never rewritten in place;
-- the only path that removes rows is a full re-ingest after a continuity
-- failure (DELETE + re-INSERT under the same session, one transaction).
CREATE TABLE sessions.transcript_chunks (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions.sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  byte_start BIGINT NOT NULL,
  byte_end BIGINT NOT NULL,
  msg_seq_start INTEGER NOT NULL,
  msg_seq_end INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, seq)
);

CREATE INDEX idx_transcript_chunks_session_seq
  ON sessions.transcript_chunks (session_id, seq);

-- Message index: (session, seq) -> uuid + the chunk that holds it. Powers
-- anchor lookups (around-a-message) and message-range reads on chunked
-- sessions without scanning every chunk.
CREATE TABLE sessions.transcript_messages (
  session_id UUID NOT NULL REFERENCES sessions.sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  uuid TEXT,
  chunk_seq INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX idx_transcript_messages_uuid
  ON sessions.transcript_messages (session_id, uuid)
  WHERE uuid IS NOT NULL;
