-- Session Outlines - AI-generated summaries using Claude Haiku
-- Adds outline column and integrates with full-text search

-- Add outline columns
ALTER TABLE sessions.sessions ADD COLUMN outline TEXT;
ALTER TABLE sessions.sessions ADD COLUMN outline_hash VARCHAR(32);

-- Index for finding sessions needing outline generation
-- Partial index covers: never generated (outline IS NULL) or stale (hash mismatch)
CREATE INDEX idx_sessions_outline_pending
  ON sessions.sessions (started_at DESC)
  WHERE outline IS NULL OR outline_hash IS DISTINCT FROM transcript_hash;

-- Update search trigger to include outline in Weight A
-- This allows searching by AI-generated summary terms
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

    -- Weight A: user messages + outline (highest priority for search)
    -- Weight B: tools and files touched
    -- Weight C: project path
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.search_text, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.outline, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(tools_text, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(files_text, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.project_path, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
