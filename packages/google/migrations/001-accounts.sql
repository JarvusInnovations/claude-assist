-- Google Module: Accounts and User Settings
-- Stores Google account OAuth credentials and per-account configuration

CREATE SCHEMA IF NOT EXISTS google;

-- Google accounts with OAuth tokens and settings
CREATE TABLE google.accounts (
    id SERIAL PRIMARY KEY,
    identifier VARCHAR(50) UNIQUE NOT NULL,  -- 'personal', 'work'
    email VARCHAR(255) NOT NULL,
    display_name TEXT,
    oauth_credentials JSONB,  -- { access_token, refresh_token, token_type, expiry_date, scope }
    is_primary BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    settings_updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Email sync settings
    email_history_id VARCHAR(50),     -- Gmail sync cursor for incremental sync
    email_last_sync_at TIMESTAMPTZ,
    email_sync_start_date DATE,       -- Only sync emails from this date forward

    -- Email triage settings
    email_triage_instructions TEXT,   -- Account-specific rules for Haiku triage
    email_label_prefix VARCHAR(20) DEFAULT 'AI',        -- AI/Triaged, etc.
    email_label_prefix_todo VARCHAR(20) DEFAULT 'TODO'  -- TODO/Respond, etc.
);

-- User aliases for name disambiguation in commitment extraction
-- Example: "Chris", "Chris Alfano" -> owner, "Christopher" alone -> different person
CREATE TABLE google.user_aliases (
    id SERIAL PRIMARY KEY,
    account_id INTEGER REFERENCES google.accounts(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,              -- "Chris", "Chris Alfano", etc.
    is_owner BOOLEAN DEFAULT true,    -- true = refers to account owner
    refers_to TEXT,                   -- If not owner, who does it refer to?
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(account_id, alias)
);

-- Indexes
CREATE INDEX idx_aliases_account ON google.user_aliases(account_id);
CREATE INDEX idx_accounts_email ON google.accounts(email);
