-- Google Module: Triage Rules and Topics of Interest
-- Database-driven configuration for email triage

-- Topics of Interest (for scoring RFPs and newsletters)
CREATE TABLE google.topics_of_interest (
    id SERIAL PRIMARY KEY,
    account_id INTEGER REFERENCES google.accounts(id) ON DELETE CASCADE,
    topic_type VARCHAR(20) NOT NULL,  -- 'keyword', 'domain', 'exclude'
    value TEXT NOT NULL,              -- The keyword/domain/exclude term
    description TEXT,                 -- Optional explanation
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_topics_account ON google.topics_of_interest(account_id, topic_type, enabled);

-- Triage rules (pattern matching before AI triage)
CREATE TABLE google.triage_rules (
    id SERIAL PRIMARY KEY,
    account_id INTEGER REFERENCES google.accounts(id) ON DELETE CASCADE,
    rule_id VARCHAR(50) NOT NULL,     -- e.g., 'calendar-invitations'
    name VARCHAR(100) NOT NULL,
    description TEXT,

    -- Pattern matching
    from_patterns TEXT[],             -- Email/domain patterns: ['*@mercury.com', 'noreply@*']
    subject_contains TEXT[],          -- Subject keywords
    body_contains TEXT[],             -- Body keywords
    body_not_contains TEXT[],         -- Negative body patterns

    -- Action
    action VARCHAR(20) NOT NULL,      -- 'archive', 'leave', 'spam', 'analyze_relevance'
    gmail_action VARCHAR(20),         -- Explicit gmail_action if different
    priority_level VARCHAR(10),       -- 'high', 'medium', 'low'

    -- Categorization
    digest_section VARCHAR(20),       -- 'calendar', 'financial', 'opportunities', 'newsletters'
    assess_against_topics BOOLEAN DEFAULT false,  -- Score against topics_of_interest
    assigned_domain VARCHAR(20),      -- Pre-assign domain if known
    assigned_type VARCHAR(20),        -- Pre-assign type if known

    -- Rule behavior
    skip_ai_triage BOOLEAN DEFAULT false,  -- Apply directly without Haiku

    -- Metadata
    enabled BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 0,       -- Higher = evaluated first
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(account_id, rule_id)
);

CREATE INDEX idx_rules_account ON google.triage_rules(account_id, enabled, priority DESC);

-- Add foreign key from emails to rules
ALTER TABLE google.emails
  ADD CONSTRAINT fk_emails_rule
  FOREIGN KEY (rule_matched_id)
  REFERENCES google.triage_rules(id)
  ON DELETE SET NULL;

-- Updated_at trigger for rules
CREATE OR REPLACE FUNCTION google.update_rule_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rules_updated_trigger
  BEFORE UPDATE ON google.triage_rules
  FOR EACH ROW EXECUTE FUNCTION google.update_rule_updated_at();

-- Updated_at trigger for account settings
CREATE TRIGGER settings_updated_trigger
  BEFORE UPDATE ON google.account_settings
  FOR EACH ROW EXECUTE FUNCTION google.update_rule_updated_at();
