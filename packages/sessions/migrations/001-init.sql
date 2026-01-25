-- Session Ingestion System - Phase 2
-- Kuato-inspired schema for archiving Claude Code transcripts

CREATE SCHEMA IF NOT EXISTS sessions;

-- Track source machines (localhost, laptop, devbox, etc.)
CREATE TABLE sessions.machines (
    id SERIAL PRIMARY KEY,
    machine_id VARCHAR(255) UNIQUE NOT NULL,
    hostname VARCHAR(255),
    is_localhost BOOLEAN DEFAULT FALSE,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_sync_at TIMESTAMPTZ,
    session_count INTEGER DEFAULT 0
);

-- Main session records
CREATE TABLE sessions.sessions (
    id UUID PRIMARY KEY,
    machine_id INTEGER NOT NULL REFERENCES sessions.machines(id),

    -- Location context
    project_path TEXT,
    git_branch VARCHAR(255),

    -- Timing
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,

    -- Extracted data (JSONB for flexibility + queryability)
    user_messages JSONB DEFAULT '[]',
    tools_used JSONB DEFAULT '[]',
    files_touched JSONB DEFAULT '[]',

    -- Token usage (aggregated)
    input_tokens BIGINT DEFAULT 0,
    output_tokens BIGINT DEFAULT 0,
    cache_read_tokens BIGINT DEFAULT 0,

    -- Transcript storage (complete archive - Claude prunes after ~1 month)
    transcript_path TEXT,
    transcript_hash VARCHAR(32) NOT NULL,
    raw_transcript TEXT NOT NULL,

    -- Full-text search
    search_text TEXT,
    search_vector TSVECTOR,

    -- Metadata
    message_count INTEGER DEFAULT 0,
    claude_version VARCHAR(50),
    synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_sessions_machine ON sessions.sessions(machine_id);
CREATE INDEX idx_sessions_project ON sessions.sessions(project_path);
CREATE INDEX idx_sessions_started ON sessions.sessions(started_at DESC);
CREATE INDEX idx_sessions_hash ON sessions.sessions(transcript_hash);
CREATE INDEX idx_sessions_search ON sessions.sessions USING GIN(search_vector);
CREATE INDEX idx_sessions_tools ON sessions.sessions USING GIN(tools_used jsonb_path_ops);

-- Weighted search vector trigger (Kuato pattern)
-- Weight A: user messages (highest priority for search)
-- Weight B: tools and files touched
-- Weight C: project path
CREATE OR REPLACE FUNCTION sessions.update_search_vector()
RETURNS TRIGGER AS $$
DECLARE
    tools_text TEXT := '';
    files_text TEXT := '';
BEGIN
    -- Safely extract tools if it's an array
    IF NEW.tools_used IS NOT NULL AND jsonb_typeof(NEW.tools_used) = 'array' AND jsonb_array_length(NEW.tools_used) > 0 THEN
        SELECT string_agg(value::text, ' ') INTO tools_text FROM jsonb_array_elements_text(NEW.tools_used);
    END IF;

    -- Safely extract files if it's an array
    IF NEW.files_touched IS NOT NULL AND jsonb_typeof(NEW.files_touched) = 'array' AND jsonb_array_length(NEW.files_touched) > 0 THEN
        SELECT string_agg(value::text, ' ') INTO files_text FROM jsonb_array_elements_text(NEW.files_touched);
    END IF;

    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.search_text, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(tools_text, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(files_text, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.project_path, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_search_trigger
    BEFORE INSERT OR UPDATE ON sessions.sessions
    FOR EACH ROW EXECUTE FUNCTION sessions.update_search_vector();
