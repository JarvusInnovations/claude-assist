-- Google Module: Email action layer — review/execute workflow + plan/execution columns
--
-- Restores (as a forward migration on today's schema) the reviewed/executed
-- workflow states and the plan + execution columns from the deleted design
-- (recoverable at claude-assist eb5369c8^:packages/google/migrations/002-emails.sql).
-- The original 002 shipped all of this in one table definition; here it is
-- re-applied additively on the drifted base, which only carries
-- discovered/new/triaged and no plan/execution columns.
--
-- The deterministic executor (services/gmail-executor.ts) reads planned_labels /
-- gmail_action and writes the applied_* columns; it never calls a model.

-- 1. Extend the workflow state machine ------------------------------------------
--    ADD VALUE IF NOT EXISTS is transaction-safe on PostgreSQL 12+ as long as
--    the new labels are not *used* in the same transaction (they aren't here —
--    only the runtime executor references them, in a later connection).
ALTER TYPE google.workflow_status ADD VALUE IF NOT EXISTS 'reviewed';   -- human/plan review complete
ALTER TYPE google.workflow_status ADD VALUE IF NOT EXISTS 'executed';   -- deterministic actions applied

-- 2. Plan columns (populated at triage; editable during review) ------------------
ALTER TABLE google.emails
    ADD COLUMN IF NOT EXISTS reviewed_at        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS executed_at        TIMESTAMPTZ,
    -- Full Gmail label paths the plan will apply, e.g.
    -- {'AI/Triaged','AI/Type/Newsletter','TODO/Review'}. Stored already
    -- namespaced with the account's configured label prefixes.
    ADD COLUMN IF NOT EXISTS planned_labels      TEXT[],
    -- 'leave' | 'archive' | 'spam' (spam = move to Gmail Spam, never delete).
    ADD COLUMN IF NOT EXISTS gmail_action        VARCHAR(20),
    -- Digest bucket the email belongs to (calendar, financial, opportunities,
    -- newsletters, notifications, personal, spam, ...). Free text VARCHAR(20).
    ADD COLUMN IF NOT EXISTS digest_section      VARCHAR(20),
    -- 0-1; rule matches are 1.0 (deterministic), AI-derived plans carry the
    -- model's/heuristic confidence.
    ADD COLUMN IF NOT EXISTS triage_confidence   FLOAT,
    ADD COLUMN IF NOT EXISTS rule_matched_id     INTEGER,
    -- Whether the urgent-alert path fired for this email (backstop / audit).
    ADD COLUMN IF NOT EXISTS alerted_at          TIMESTAMPTZ,

    -- 3. Execution results (written only by the executor) -----------------------
    ADD COLUMN IF NOT EXISTS applied_labels        TEXT[],
    ADD COLUMN IF NOT EXISTS applied_gmail_action  VARCHAR(20),
    ADD COLUMN IF NOT EXISTS applied_at            TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS execution_notes       TEXT,
    ADD COLUMN IF NOT EXISTS execution_error       TEXT,
    ADD COLUMN IF NOT EXISTS execution_error_at    TIMESTAMPTZ;

-- 4. Indexes for the review/execute/digest queries ------------------------------
-- Emails whose plan is staged and awaiting confirm-to-execute (the daily digest
-- and the execute endpoint both scan this set).
CREATE INDEX IF NOT EXISTS idx_emails_pending_execute
    ON google.emails(account_id, digest_section)
    WHERE workflow_status = 'triaged' AND gmail_action IS NOT NULL;

-- Spam-quarantine review (weekly digest): planned-or-applied spam moves.
CREATE INDEX IF NOT EXISTS idx_emails_spam_quarantine
    ON google.emails(account_id, executed_at)
    WHERE gmail_action = 'spam';
