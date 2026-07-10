-- Google Module: Deterministic pre-AI triage rules + topics of interest
--
-- The database-driven rule engine: rules match on sender / subject / body
-- patterns BEFORE any model call; a matching skip_ai_triage rule applies a
-- deterministic plan and never spends a Haiku turn. Bootstrap seed content is
-- loaded at boot from GOOGLE_TRIAGE_SEED_FILE (or a few generic examples when
-- unset) — see services/seed-rules.ts. The table is the source of truth.

-- Topics of Interest — used to score opportunity/newsletter relevance.
CREATE TABLE IF NOT EXISTS google.topics_of_interest (
    id SERIAL PRIMARY KEY,
    account_id INTEGER REFERENCES google.accounts(id) ON DELETE CASCADE,
    topic_type VARCHAR(20) NOT NULL,  -- 'keyword' | 'domain' | 'exclude'
    value TEXT NOT NULL,
    description TEXT,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(account_id, topic_type, value)
);

CREATE INDEX IF NOT EXISTS idx_topics_account
    ON google.topics_of_interest(account_id, topic_type, enabled);

-- Triage rules — deterministic pattern matching evaluated before AI triage.
CREATE TABLE IF NOT EXISTS google.triage_rules (
    id SERIAL PRIMARY KEY,
    account_id INTEGER REFERENCES google.accounts(id) ON DELETE CASCADE,
    rule_id VARCHAR(50) NOT NULL,     -- stable slug, e.g. 'calendar-invitations'
    name VARCHAR(100) NOT NULL,
    description TEXT,

    -- Pattern matching (all present clauses must match; each clause is an OR
    -- over its patterns). from_patterns support '*' / '?' globs.
    from_patterns TEXT[],
    subject_contains TEXT[],
    body_contains TEXT[],
    body_not_contains TEXT[],

    -- Action
    action VARCHAR(20) NOT NULL,      -- 'archive' | 'leave' | 'spam' | 'analyze_relevance'
    gmail_action VARCHAR(20),         -- explicit override: 'leave' | 'archive' | 'spam'
    priority_level VARCHAR(10),       -- 'high' | 'medium' | 'low'

    -- Categorization
    digest_section VARCHAR(20),       -- calendar | financial | opportunities | newsletters | ...
    assess_against_topics BOOLEAN DEFAULT false,
    assigned_domain VARCHAR(20),
    assigned_type VARCHAR(20),

    -- Behavior
    skip_ai_triage BOOLEAN DEFAULT false,  -- apply deterministically, no Haiku turn

    -- Metadata
    enabled BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 0,       -- higher = evaluated first
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(account_id, rule_id)
);

CREATE INDEX IF NOT EXISTS idx_rules_account
    ON google.triage_rules(account_id, enabled, priority DESC);

-- Link emails.rule_matched_id → the rule that matched (nullable, SET NULL on delete).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_emails_rule'
    ) THEN
        ALTER TABLE google.emails
            ADD CONSTRAINT fk_emails_rule
            FOREIGN KEY (rule_matched_id)
            REFERENCES google.triage_rules(id)
            ON DELETE SET NULL;
    END IF;
END $$;

-- Updated_at trigger for rules.
CREATE OR REPLACE FUNCTION google.update_rule_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rules_updated_trigger ON google.triage_rules;
CREATE TRIGGER rules_updated_trigger
  BEFORE UPDATE ON google.triage_rules
  FOR EACH ROW EXECUTE FUNCTION google.update_rule_updated_at();
