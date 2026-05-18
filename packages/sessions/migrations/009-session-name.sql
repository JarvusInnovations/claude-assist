-- User-set custom session name (from Claude Code's /title rename)
-- Stored separately from the AI-generated `title` (outline) so renames take precedence
-- without overwriting the AI summary.

ALTER TABLE sessions.sessions ADD COLUMN session_name VARCHAR(255);

-- Add session_name to search_vector with weight A (same priority as title/outline)
CREATE OR REPLACE FUNCTION sessions.update_search_vector()
RETURNS TRIGGER AS $$
DECLARE
    tools_text TEXT := '';
    files_text TEXT := '';
BEGIN
    IF NEW.tools_used IS NOT NULL AND jsonb_typeof(NEW.tools_used) = 'array' AND jsonb_array_length(NEW.tools_used) > 0 THEN
        SELECT string_agg(value::text, ' ') INTO tools_text FROM jsonb_array_elements_text(NEW.tools_used);
    END IF;

    IF NEW.files_touched IS NOT NULL AND jsonb_typeof(NEW.files_touched) = 'array' AND jsonb_array_length(NEW.files_touched) > 0 THEN
        SELECT string_agg(value::text, ' ') INTO files_text FROM jsonb_array_elements_text(NEW.files_touched);
    END IF;

    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.search_text, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.outline, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.session_name, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(tools_text, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(files_text, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.project_path, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
