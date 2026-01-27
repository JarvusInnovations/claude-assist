-- File Operations - Differentiate read vs write operations in files_touched
-- Migrates from string[] to { reads: string[], writes: string[] }

-- Step 1: Migrate existing data in-place
-- Since JSONB is flexible, we transform the existing array to the new structure
-- Existing files are placed in reads (conservative assumption - we can't retroactively determine operation type)
UPDATE sessions.sessions
SET files_touched = jsonb_build_object(
  'reads', COALESCE(files_touched, '[]'::jsonb),
  'writes', '[]'::jsonb
)
WHERE jsonb_typeof(files_touched) = 'array';

-- Handle null case
UPDATE sessions.sessions
SET files_touched = jsonb_build_object('reads', '[]'::jsonb, 'writes', '[]'::jsonb)
WHERE files_touched IS NULL;

-- Step 2: Update the search vector trigger to handle new structure
CREATE OR REPLACE FUNCTION sessions.update_search_vector()
RETURNS TRIGGER AS $$
DECLARE
    tools_text TEXT := '';
    files_text TEXT := '';
    reads_text TEXT := '';
    writes_text TEXT := '';
BEGIN
    -- Safely extract tools if it's an array
    IF NEW.tools_used IS NOT NULL AND jsonb_typeof(NEW.tools_used) = 'array' AND jsonb_array_length(NEW.tools_used) > 0 THEN
        SELECT string_agg(value::text, ' ') INTO tools_text FROM jsonb_array_elements_text(NEW.tools_used);
    END IF;

    -- Handle new files_touched structure: { reads: [], writes: [] }
    IF NEW.files_touched IS NOT NULL AND jsonb_typeof(NEW.files_touched) = 'object' THEN
        -- Extract reads
        IF NEW.files_touched->'reads' IS NOT NULL
           AND jsonb_typeof(NEW.files_touched->'reads') = 'array'
           AND jsonb_array_length(NEW.files_touched->'reads') > 0 THEN
            SELECT string_agg(value::text, ' ') INTO reads_text
            FROM jsonb_array_elements_text(NEW.files_touched->'reads');
        END IF;

        -- Extract writes
        IF NEW.files_touched->'writes' IS NOT NULL
           AND jsonb_typeof(NEW.files_touched->'writes') = 'array'
           AND jsonb_array_length(NEW.files_touched->'writes') > 0 THEN
            SELECT string_agg(value::text, ' ') INTO writes_text
            FROM jsonb_array_elements_text(NEW.files_touched->'writes');
        END IF;

        -- Combine for search
        files_text := COALESCE(reads_text, '') || ' ' || COALESCE(writes_text, '');
    -- Backward compatibility: handle legacy array format (shouldn't happen after migration)
    ELSIF NEW.files_touched IS NOT NULL AND jsonb_typeof(NEW.files_touched) = 'array' AND jsonb_array_length(NEW.files_touched) > 0 THEN
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

-- Step 3: Add GIN indexes for efficient querying of reads and writes separately
CREATE INDEX idx_sessions_files_reads ON sessions.sessions USING GIN((files_touched->'reads') jsonb_path_ops);
CREATE INDEX idx_sessions_files_writes ON sessions.sessions USING GIN((files_touched->'writes') jsonb_path_ops);
