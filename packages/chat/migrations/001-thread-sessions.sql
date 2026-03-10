-- Map Slack threads to Agent SDK sessions
CREATE TABLE chat.thread_sessions (
  id SERIAL PRIMARY KEY,
  thread_id TEXT UNIQUE NOT NULL,        -- Chat SDK thread ID (e.g. slack:D123:1234567890.123456)
  session_id TEXT NOT NULL,              -- Agent SDK session ID (UUID)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_thread_sessions_session_id ON chat.thread_sessions(session_id);
