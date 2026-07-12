-- Google Module: digest v2 — sender standing + classification refinement queue.
--
-- Two interactive-digest affordances land here (behavior: email-digest):
--
--   sender_standing — a per-sender decision the digest page captures with one
--     tap on a newsletter row: `whitelist` (keep delivering, STOP asking about
--     it in later digests) or `unsubscribe_queue` (feed the future unsubscribe
--     automation). One row per sender address; a later tap overwrites the
--     standing. Whitelisted senders are filtered out of the pending digest so
--     they stop appearing as questions; unsubscribe_queue rows are the ONLY
--     source the (future) unsubscribe automation reads from.
--
--   classification_refinements — an append-only correction queue. A reclassify
--     tap writes {email_id, from_class, to_class, note}; the reclassification
--     takes effect for THAT email immediately (its digest placement is updated
--     inline by the route), but rules/prompts are NEVER self-modified here.
--     The queue is drained only in a deliberate interactive revision session,
--     which marks each entry resolved with what changed (`resolution`). This is
--     the "corrections are gathered, revisions are sessions" principle: signal
--     capture is decoupled from policy change.

CREATE TABLE google.sender_standing (
    -- Lowercased sender email; one standing per sender.
    sender_email  TEXT PRIMARY KEY,
    standing      TEXT NOT NULL CHECK (standing IN ('whitelist', 'unsubscribe_queue')),
    set_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Where the decision came from (e.g. 'digest_page'); free-form provenance.
    source        TEXT
);

CREATE INDEX idx_sender_standing_standing ON google.sender_standing(standing);

CREATE TABLE google.classification_refinements (
    id            SERIAL PRIMARY KEY,
    email_id      INTEGER NOT NULL REFERENCES google.emails(id) ON DELETE CASCADE,
    -- Category/tier the email WAS in vs. what the owner reclassified it to.
    from_class    TEXT,
    to_class      TEXT NOT NULL,
    note          TEXT,
    -- Queue lifecycle: pending until an interactive revision session resolves it.
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
    -- What the session decided (a rule/prompt change, or "noted, no change").
    resolution    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at   TIMESTAMPTZ
);

CREATE INDEX idx_classification_refinements_status
    ON google.classification_refinements(status, created_at);
CREATE INDEX idx_classification_refinements_email
    ON google.classification_refinements(email_id);
