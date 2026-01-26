-- Google Module: Email Storage and Triage State
-- Stores synced emails with full analysis structure

-- Workflow status enum for email processing states
-- Note: Errors are tracked separately via last_error/last_error_at columns
CREATE TYPE google.workflow_status AS ENUM (
    'discovered',  -- Listed from Gmail but not yet fetched
    'new',         -- Fetched and ready for triage
    'triaged',     -- AI analysis complete
    'reviewed',    -- Human review complete
    'executed'     -- Actions applied
);

CREATE TABLE google.emails (
    id SERIAL PRIMARY KEY,
    account_id INTEGER REFERENCES google.accounts(id) ON DELETE CASCADE,
    message_id VARCHAR(50) NOT NULL,
    thread_id VARCHAR(50),

    -- Workflow State Machine
    workflow_status google.workflow_status DEFAULT 'new',
    triaged_at TIMESTAMPTZ,
    reviewed_at TIMESTAMPTZ,
    executed_at TIMESTAMPTZ,

    -- Gmail Metadata
    date TIMESTAMPTZ,
    from_address TEXT,
    from_name TEXT,
    to_addresses TEXT[],
    cc_addresses TEXT[],
    subject TEXT,
    snippet TEXT,                -- Gmail preview (~100 chars)
    gmail_labels JSONB,          -- Gmail label names at sync time

    -- Content (always fetched during sync)
    body_text TEXT,
    body_html TEXT,
    has_attachments BOOLEAN DEFAULT false,

    -- Analysis (from Haiku triage)
    email_type VARCHAR(20),      -- 'personal' | 'automated'
    domain VARCHAR(20),          -- 'client' | 'finance' | 'transit' | ...
    contact_file TEXT,           -- Soft link to knowledge base contact
    thread_context JSONB,        -- { parent_labels: [], parent_summary: "" }
    overview TEXT,               -- 2-4 sentence summary
    potential_action_items JSONB, -- [{type: "commitment", description: "desc"}, ...]
    potential_extractions TEXT[], -- ['commitment', 'backlog', 'contact_update']
    digest_section VARCHAR(20),  -- 'calendar' | 'financial' | 'opportunities' | 'newsletters'
    interesting BOOLEAN,         -- RFP/newsletter relevance (null if not applicable)
    analysis_notes TEXT,         -- Contextual observations

    -- Plan (editable during review)
    planned_labels TEXT[],       -- ['d/Client', 's/Personal', 'p/High', 'TODO/Respond']
    gmail_action VARCHAR(20),    -- 'leave' | 'archive' | 'spam'
    extractions JSONB,           -- Rich extraction objects

    -- Triage Confidence
    triage_confidence FLOAT,     -- 0-1 confidence score
    rule_matched_id INTEGER,     -- FK to triage_rules if rule matched

    -- Error Tracking (separate from workflow status to preserve state on failure)
    last_error TEXT,             -- Error message from last failed operation
    last_error_at TIMESTAMPTZ,   -- When the error occurred

    -- Execution Results
    applied_labels TEXT[],
    applied_gmail_action VARCHAR(20),
    applied_extractions TEXT[],  -- Descriptions of completed extractions
    execution_notes TEXT,

    -- Full-text search
    search_vector TSVECTOR,

    -- Metadata
    synced_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(account_id, message_id)
);

-- Indexes for common queries
CREATE INDEX idx_emails_account ON google.emails(account_id);
CREATE INDEX idx_emails_date ON google.emails(date DESC);
CREATE INDEX idx_emails_workflow ON google.emails(workflow_status);
CREATE INDEX idx_emails_domain ON google.emails(domain);
CREATE INDEX idx_emails_thread ON google.emails(thread_id);
CREATE INDEX idx_emails_digest ON google.emails(digest_section) WHERE digest_section IS NOT NULL;
CREATE INDEX idx_emails_interesting ON google.emails(interesting) WHERE interesting = true;
CREATE INDEX idx_emails_search ON google.emails USING GIN(search_vector);
CREATE INDEX idx_emails_discovered ON google.emails(account_id) WHERE workflow_status = 'discovered';
CREATE INDEX idx_emails_errors ON google.emails(account_id, last_error_at DESC) WHERE last_error IS NOT NULL;

-- Search trigger (weighted: subject/overview high, from/snippet medium, body low)
CREATE OR REPLACE FUNCTION google.update_email_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.subject, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.overview, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.from_name, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.snippet, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.body_text, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER emails_search_trigger
  BEFORE INSERT OR UPDATE ON google.emails
  FOR EACH ROW EXECUTE FUNCTION google.update_email_search_vector();

-- Updated_at trigger
CREATE OR REPLACE FUNCTION google.update_email_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER emails_updated_trigger
  BEFORE UPDATE ON google.emails
  FOR EACH ROW EXECUTE FUNCTION google.update_email_updated_at();
