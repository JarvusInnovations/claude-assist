-- Model spend ledger (specs/modules/invoker.md).
--
-- One row per metered model invocation, INCLUDING each transport retry.
-- Nothing is aggregated at write time: the window totals, the per-task
-- breakdown, and any later cost analysis are all queries over this table.
--
-- Before this existed, `usage` was never read at a single call site in the
-- system. The cheapest useful version of "honest billing" is a row per call.

CREATE SCHEMA IF NOT EXISTS invoker;

CREATE TABLE invoker.invocations (
    id             BIGSERIAL PRIMARY KEY,
    ts             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    task           TEXT NOT NULL,          -- stable dotted call-site id
    tier           TEXT NOT NULL,          -- classify | extract | vision | synthesize
    model          TEXT NOT NULL,          -- what the tier resolved to
    attempt        INT  NOT NULL DEFAULT 1,-- 1-based; retries append their own rows
    outcome        TEXT NOT NULL           -- succeeded | failed
                   CHECK (outcome IN ('succeeded','failed')),
    error_reason   TEXT,                   -- ModelFailureReason when outcome = failed
    stop_reason    TEXT,
    input_tokens   INT NOT NULL DEFAULT 0,
    output_tokens  INT NOT NULL DEFAULT 0,
    cache_write_tokens INT NOT NULL DEFAULT 0,
    cache_read_tokens  INT NOT NULL DEFAULT 0,
    -- Estimated from the price table in code. Micro-dollars, so a cheap
    -- classify call is not rounded to zero and totals stay exact integers.
    cost_micros    BIGINT NOT NULL DEFAULT 0,
    duration_ms    INT NOT NULL DEFAULT 0
);

-- The window query: totals since a timestamp, grouped by task.
CREATE INDEX idx_invocations_ts ON invoker.invocations (ts DESC);
CREATE INDEX idx_invocations_task_ts ON invoker.invocations (task, ts DESC);
CREATE INDEX idx_invocations_failed ON invoker.invocations (ts DESC)
    WHERE outcome = 'failed';
