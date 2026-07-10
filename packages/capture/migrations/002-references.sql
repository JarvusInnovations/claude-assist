-- Capture Module: References store
--
-- Landing place for link_reference captures — the replacement for the
-- open-tabs graveyard. One row per captured reference with fully extracted
-- metadata.
--
-- Record shape is deliberately flat and export-ready: the Hari repo will
-- eventually own a `.gitsheets/references` sheet (markdown + TOML
-- frontmatter, one record per file), and each row here maps 1:1 onto that
-- record — frontmatter: url, title, site_name, tags, source, captured_at;
-- body: description + notes. The gitsheet export is a documented follow-on
-- (the Hari repo-restructure creating that sheet hasn't run yet); until
-- then Postgres is the home.

CREATE TABLE capture.references (
    -- One reference per capture; the capture ULID doubles as the stable
    -- record key a future gitsheet export can use in its path template.
    capture_ulid CHAR(26) PRIMARY KEY
        REFERENCES capture.captures(ulid) ON DELETE CASCADE,

    url TEXT NOT NULL,                    -- primary (first) URL, as captured
    final_url TEXT,                       -- after redirects, if fetched
    title TEXT,
    description TEXT,
    site_name TEXT,

    -- The capture text with the bare URL removed — Chris's own words about
    -- why he saved it (empty for pure link-dropbox captures).
    notes TEXT NOT NULL DEFAULT '',

    tags TEXT[] NOT NULL DEFAULT '{}',
    source TEXT NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,

    -- Additional URLs from the same capture, with their fetched metadata:
    -- [{url, final_url?, title?, description?, site_name?, fetch_error?}]
    extra_urls JSONB NOT NULL DEFAULT '[]',
    fetch_error TEXT,                     -- primary URL fetch failure, if any

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_references_captured_at ON capture.references(captured_at DESC);
CREATE INDEX idx_references_url ON capture.references(url);

CREATE OR REPLACE FUNCTION capture.update_references_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER references_updated_trigger
  BEFORE UPDATE ON capture.references
  FOR EACH ROW EXECUTE FUNCTION capture.update_references_updated_at();
