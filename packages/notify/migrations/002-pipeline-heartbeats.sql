-- Notify module: coverage-ledger registry / pipeline heartbeats
-- Every ingestion/sync/reconciliation pipeline registers here with a staleness
-- threshold. A successful run advances `last_success_at` (source='heartbeat');
-- externally-maintained ledgers in the Hari repo register with source='manual'
-- and a `ledger_path` the daily check parses a watermark date from.

CREATE TABLE notify.pipeline_heartbeats (
    name               TEXT PRIMARY KEY,
    last_success_at    TIMESTAMPTZ,             -- NULL until the first beat
    threshold_interval INTERVAL NOT NULL,       -- e.g. '12 hours', '48 hours', '9 days'
    source             TEXT NOT NULL DEFAULT 'heartbeat', -- heartbeat | manual
    ledger_path        TEXT,                    -- for manual: path relative to the Hari repo
    metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
