-- Add user_message_count column and backfill from user_messages JSONB array
ALTER TABLE sessions.sessions ADD COLUMN user_message_count INTEGER NOT NULL DEFAULT 0;

UPDATE sessions.sessions SET user_message_count = jsonb_array_length(COALESCE(user_messages, '[]'::jsonb));
