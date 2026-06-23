-- Tool-call index for rich transcript search (#48).
-- One row per tool_use block across all sessions, populated at ingest. Powers
-- cross-session "find this tool call" discovery; per-session windowing reads the
-- raw transcript on demand and uses msg_uuid as a durable anchor.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS sessions.tool_calls (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions.sessions(id) ON DELETE CASCADE,
  msg_uuid TEXT NOT NULL,
  msg_index INTEGER NOT NULL,
  ts TIMESTAMPTZ,
  tool_name TEXT NOT NULL,
  target TEXT,
  is_sidechain BOOLEAN NOT NULL DEFAULT FALSE
);

-- Per-session ordering (windowing) and cascade-friendly lookups.
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON sessions.tool_calls (session_id, msg_index);
-- Fast tool-name filtering (substring via ILIKE handled by the trigram index too).
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON sessions.tool_calls (tool_name);
-- Substring search over the derived target (Bash command, file path, query, ...).
CREATE INDEX IF NOT EXISTS idx_tool_calls_target_trgm ON sessions.tool_calls USING GIN (target gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_trgm ON sessions.tool_calls USING GIN (tool_name gin_trgm_ops);
-- Recency ordering for cross-session results.
CREATE INDEX IF NOT EXISTS idx_tool_calls_ts ON sessions.tool_calls (ts DESC);
