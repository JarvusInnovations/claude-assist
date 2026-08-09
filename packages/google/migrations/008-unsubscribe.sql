-- Google Module: tiered unsubscribe automation.
--
-- One row per unsubscribe ATTEMPT against one sender. The row is the unit of
-- background work (claimed through the shared lease helper — see
-- specs/behaviors/scheduled-work-leases.md) and, once terminal, the durable
-- record of what was tried and what proof exists.
--
-- The queue SOURCE is deliberately NOT this table. Senders enter automation
-- only through `google.sender_standing` with standing = 'unsubscribe_queue',
-- which is written by the owner's explicit tap on the digest page — never by
-- classifier discretion. Rows here are materialized FROM that standing, and the
-- executor re-checks the standing at execution time, so removing a sender from
-- the queue stops the automation even if a row was already enqueued.
--
-- Tiers (increasing effort/judgment):
--   1  one_click     — RFC 8058 List-Unsubscribe-Post; a single HTTPS POST.
--   2  browser_form  — link-only page driven by a headless-browser CLI, with a
--                      screenshot written to disk and its path carried into the
--                      audit ledger as proof.
--   3  review        — login walls, ambiguous forms, mailto-only, or anything
--                      the whitelist gate blocked. NEVER auto-executed; these
--                      are the weekly review queue.
--
-- `status` is the lease-queue workflow: queued → running → (succeeded | failed
-- | needs_review | skipped). `needs_review` and `skipped` are terminal human
-- outcomes, not errors: `needs_review` wants a decision, `skipped` means the
-- sender is no longer queued (or is whitelisted) and nothing was done.

CREATE TABLE google.unsubscribe_attempts (
    id                SERIAL PRIMARY KEY,

    -- Lowercased sender address; the join key back to google.sender_standing.
    sender_email      TEXT NOT NULL,
    -- Everything after the '@'. Rate limiting is per sender-domain so one
    -- provider hosting many lists is not hammered.
    sender_domain     TEXT NOT NULL,

    account_id        INTEGER REFERENCES google.accounts(id) ON DELETE CASCADE,
    -- The message the unsubscribe method was read off (headers / analysis).
    email_id          INTEGER REFERENCES google.emails(id) ON DELETE SET NULL,

    tier              SMALLINT CHECK (tier IN (1, 2, 3)),
    method            TEXT CHECK (method IN ('one_click', 'browser_form', 'review')),
    target_url        TEXT,
    -- Filesystem pointer to the tier-2 screenshot; also copied into the ledger
    -- row's context so "what did it actually do" is answerable from one query.
    proof_path        TEXT,

    status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'succeeded', 'failed',
                                        'needs_review', 'skipped')),
    -- Free-form outcome detail: gate reason, HTTP status, browser steps, etc.
    detail            JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Lease-queue columns (core `createLeaseQueue` defaults).
    attempts          INTEGER NOT NULL DEFAULT 0,
    lease_owner       TEXT,
    lease_expires_at  TIMESTAMPTZ,
    next_attempt_at   TIMESTAMPTZ,
    last_error        TEXT,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ
);

-- At most one OPEN attempt per sender: re-running the enqueue pass is
-- idempotent, and a sender re-tapped while an attempt is in flight does not
-- fan out into duplicate executions.
CREATE UNIQUE INDEX uq_unsubscribe_open_sender
    ON google.unsubscribe_attempts (sender_email)
    WHERE status IN ('queued', 'running');

-- Backs the lease helper's per-key serialization (`serializeBy: sender_domain`):
-- at most one in-flight attempt per domain, while SKIP LOCKED still gives full
-- parallelism across domains.
CREATE UNIQUE INDEX uq_unsubscribe_running_domain
    ON google.unsubscribe_attempts (sender_domain)
    WHERE status = 'running';

CREATE INDEX idx_unsubscribe_status ON google.unsubscribe_attempts (status, created_at);
-- The rate-limit window query: executed actions per domain in the last N minutes.
CREATE INDEX idx_unsubscribe_domain_completed
    ON google.unsubscribe_attempts (sender_domain, completed_at DESC);

-- `google.update_email_updated_at()` (002-emails.sql) only touches
-- NEW.updated_at, so it is table-agnostic despite the name — reused here rather
-- than cloned. It matters because the lease helper's UPDATEs set the workflow
-- columns generically and never the timestamp.
CREATE TRIGGER unsubscribe_attempts_updated_trigger
    BEFORE UPDATE ON google.unsubscribe_attempts
    FOR EACH ROW EXECUTE FUNCTION google.update_email_updated_at();
