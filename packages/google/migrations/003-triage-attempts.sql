-- Google Module: Triage retry cap
--
-- Tracks failed triage attempts per email so the scheduler can stop
-- retrying an email that fails repeatedly (e.g. an oversized HTML body that
-- keeps blowing the model's context window) instead of burning a paid
-- turn-1 call every 5-minute cycle forever. Reset to 0 on a successful
-- triage; incremented on each failure alongside last_error/last_error_at.

ALTER TABLE google.emails
    ADD COLUMN triage_attempts INTEGER NOT NULL DEFAULT 0;

-- Speeds up the scheduler's "pending, not yet capped" query and the
-- capped-count lookup used by the account status endpoint.
CREATE INDEX idx_emails_triage_attempts
    ON google.emails(account_id, triage_attempts)
    WHERE workflow_status = 'new';
