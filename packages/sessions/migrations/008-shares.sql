CREATE TABLE sessions.shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions.sessions(id) ON DELETE CASCADE,
    auth_code VARCHAR(32) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shares_auth_code ON sessions.shares(auth_code);
CREATE INDEX idx_shares_session_id ON sessions.shares(session_id);
