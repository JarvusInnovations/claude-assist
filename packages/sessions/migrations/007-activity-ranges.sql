-- Contiguous time ranges of user activity within a session
-- Each range is {start: ISO8601, end: ISO8601} computed from user message timestamps
-- with a 30-minute gap threshold
ALTER TABLE sessions.sessions ADD COLUMN activity_ranges JSONB NOT NULL DEFAULT '[]';
