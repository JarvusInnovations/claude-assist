-- Pages module: agent-published interactive HTML pages + collected responses.
--
-- pages     — one row per stable slug. `current_version_id` points at the
--             version currently served; republishing a slug adds a new
--             version row and repoints this pointer (prior versions retained).
-- versions  — immutable HTML blobs. Never updated in place, only inserted.
-- responses — append-only structured responses collected from a published
--             page (free-form JSON payload + optional anchor/note).
--             `processed_by`/`processed_at` are the only fields ever mutated
--             after insert, and only once (marking a response handled).

CREATE SCHEMA IF NOT EXISTS pages;

CREATE TABLE pages.pages (
    id                  BIGSERIAL PRIMARY KEY,
    slug                TEXT NOT NULL UNIQUE,
    title               TEXT NOT NULL,
    current_version_id  BIGINT,
    digest_optin        BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE pages.versions (
    id          BIGSERIAL PRIMARY KEY,
    page_id     BIGINT NOT NULL REFERENCES pages.pages(id) ON DELETE CASCADE,
    html        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Deferred so pages/versions can be created in either order and stay circular.
ALTER TABLE pages.pages
    ADD CONSTRAINT fk_pages_current_version
    FOREIGN KEY (current_version_id) REFERENCES pages.versions(id);

CREATE INDEX idx_versions_page_id ON pages.versions (page_id, created_at DESC);

-- Index newest-first (GET /pages).
CREATE INDEX idx_pages_active_updated
    ON pages.pages (updated_at DESC)
    WHERE archived_at IS NULL;

CREATE TABLE pages.responses (
    id            BIGSERIAL PRIMARY KEY,
    page_id       BIGINT NOT NULL REFERENCES pages.pages(id) ON DELETE CASCADE,
    payload       JSONB NOT NULL,
    anchor        TEXT,
    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_by  TEXT,
    processed_at  TIMESTAMPTZ
);

CREATE INDEX idx_responses_page_created ON pages.responses (page_id, created_at);

-- GET .../responses?unprocessed=true
CREATE INDEX idx_responses_unprocessed
    ON pages.responses (page_id, created_at)
    WHERE processed_at IS NULL;
