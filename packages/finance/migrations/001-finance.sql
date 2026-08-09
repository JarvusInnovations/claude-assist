-- Finance module: personal ledger mirror + monthly review batch + assist.
--
-- PERSONAL DOMAIN. Everything in this schema is the instance owner's private
-- financial data. The module ships no write path to any shared/team system of
-- record and must not grow one.
--
-- Three tables, three jobs:
--   transactions  — a local mirror of the provider's ledger, upserted by the
--                   pull. The mirror exists so the review is reproducible and
--                   so a provider outage degrades to "stale" rather than "no
--                   review at all".
--   reviews       — one row per period, lease-claimed (the period IS the work
--                   item), carrying where the rendered review landed.
--   suggestions   — the assist's output. A suggestion is a PROPOSAL: it never
--                   changes `transactions`, and reaching the provider requires
--                   a separate, human-initiated apply.

CREATE TABLE finance.accounts (
    external_id   TEXT PRIMARY KEY,          -- the provider's account id
    name          TEXT NOT NULL,
    type          TEXT,
    subtype       TEXT,
    institution   TEXT,
    currency      TEXT,
    balance       NUMERIC(18, 2),
    is_asset      BOOLEAN,
    raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
    synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE finance.transactions (
    external_id     TEXT PRIMARY KEY,        -- the provider's transaction id
    posted_on       DATE NOT NULL,
    amount          NUMERIC(18, 2) NOT NULL, -- provider sign convention, preserved
    currency        TEXT,
    merchant        TEXT,
    description     TEXT,
    account_id      TEXT,
    category_id     TEXT,
    category_name   TEXT,
    notes           TEXT,
    tags            TEXT[] NOT NULL DEFAULT '{}',
    is_pending      BOOLEAN NOT NULL DEFAULT FALSE,
    needs_review    BOOLEAN NOT NULL DEFAULT FALSE,
    raw             JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_finance_transactions_posted_on ON finance.transactions (posted_on DESC);
CREATE INDEX idx_finance_transactions_category ON finance.transactions (category_name);
CREATE INDEX idx_finance_transactions_needs_review
    ON finance.transactions (needs_review) WHERE needs_review;

-- One review per period. `period_key` is the ISO month (YYYY-MM), which makes
-- the natural idempotency key of the whole batch a primary key.
CREATE TABLE finance.reviews (
    id                BIGSERIAL PRIMARY KEY,
    period_key        TEXT NOT NULL UNIQUE,
    period_start      DATE NOT NULL,
    period_end        DATE NOT NULL,          -- inclusive
    status            TEXT NOT NULL DEFAULT 'pending',
                      -- pending | running | rendered | failed | blocked
    -- Where the rendered review landed.
    page_slug         TEXT,
    page_url          TEXT,
    tana_node_id      TEXT,
    notified_at       TIMESTAMPTZ,
    -- Composed summary, kept so the page can be re-rendered without re-pulling.
    summary           JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Why a run stopped short without being a failure (e.g. the source is not
    -- configured). A blocked review is a clean exit, not an error.
    blocked_reason    TEXT,
    -- Lease columns (specs/behaviors/scheduled-work-leases.md).
    attempts          INTEGER NOT NULL DEFAULT 0,
    lease_owner       TEXT,
    lease_expires_at  TIMESTAMPTZ,
    next_attempt_at   TIMESTAMPTZ,
    last_error        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_finance_reviews_status ON finance.reviews (status, next_attempt_at);

-- Deliberately NO partial unique index forcing a single running review. The
-- scheduled batch already runs under its advisory lock and claims one row at a
-- time, and a unique-violation raised by the claim itself would turn a stuck
-- lease into a hard error instead of a reclaim.

-- The assist's proposals. `applied_at` is the ONLY column whose being set means
-- the provider's ledger was touched, and it is only ever set by an explicit,
-- human-initiated apply call.
CREATE TABLE finance.suggestions (
    id              BIGSERIAL PRIMARY KEY,
    review_id       BIGINT NOT NULL REFERENCES finance.reviews(id) ON DELETE CASCADE,
    transaction_id  TEXT NOT NULL,
    kind            TEXT NOT NULL,            -- category | note
    current_value   TEXT,
    suggested_value TEXT NOT NULL,
    rationale       TEXT,
    confidence      TEXT,                     -- high | medium | low
    status          TEXT NOT NULL DEFAULT 'proposed',
                    -- proposed | accepted | rejected | applied | failed
    decided_at      TIMESTAMPTZ,
    decided_by      TEXT,
    applied_at      TIMESTAMPTZ,
    apply_error     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (review_id, transaction_id, kind)
);

CREATE INDEX idx_finance_suggestions_review ON finance.suggestions (review_id, status);

-- Provider session material, so a pull doesn't re-authenticate every run (and
-- doesn't re-trip MFA). Single row by construction: one owner, one account.
CREATE TABLE finance.provider_session (
    id           INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    token        TEXT NOT NULL,
    obtained_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);
