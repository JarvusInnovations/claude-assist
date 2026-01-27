-- File Operations - Differentiate read vs write operations in files_touched
-- Changes format from string[] to { reads: string[], writes: string[] }
--
-- PREREQUISITE: Run the reparse script BEFORE this migration:
--   bun packages/sessions/scripts/reparse-files-touched.ts

-- Update the search vector trigger for new { reads, writes } format
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

    -- Extract files from { reads: [], writes: [] } structure
    IF NEW.files_touched IS NOT NULL AND jsonb_typeof(NEW.files_touched) = 'object' THEN
        SELECT string_agg(value::text, ' ') INTO files_text
        FROM (
            SELECT value FROM jsonb_array_elements_text(COALESCE(NEW.files_touched->'reads', '[]'::jsonb))
            UNION ALL
            SELECT value FROM jsonb_array_elements_text(COALESCE(NEW.files_touched->'writes', '[]'::jsonb))
        ) combined;
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

-- Add GIN indexes for efficient querying of reads and writes separately
CREATE INDEX IF NOT EXISTS idx_sessions_files_reads ON sessions.sessions USING GIN((files_touched->'reads') jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_sessions_files_writes ON sessions.sessions USING GIN((files_touched->'writes') jsonb_path_ops);
