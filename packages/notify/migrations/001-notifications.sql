-- Notify module: notification delivery log
-- One row per dispatch through the single notification dispatcher.
--
-- Session-control (RC takeover) links are secrets: they are delivered to the
-- channel but NEVER stored in plaintext here. `url_redacted` holds a redacted
-- form; `payload_hash` is a sha256 over the real payload so a delivery can be
-- correlated without persisting the secret.

CREATE SCHEMA IF NOT EXISTS notify;

CREATE TABLE notify.notifications (
    id            BIGSERIAL PRIMARY KEY,
    ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    priority      TEXT NOT NULL,               -- interrupt | notice | digest
    title         TEXT NOT NULL,               -- redacted
    body          TEXT NOT NULL,               -- redacted
    delivered_via TEXT[] NOT NULL DEFAULT '{}',-- channels actually reached
    url_redacted  TEXT,                        -- redacted form of the link, if any
    payload_hash  TEXT NOT NULL,               -- sha256 of the real payload
    status        TEXT NOT NULL,               -- sent | pending | error
    error         TEXT                         -- per-channel delivery errors, if any
);

-- Digest flush selects pending rows in arrival order.
CREATE INDEX idx_notifications_pending
    ON notify.notifications (ts)
    WHERE status = 'pending';

CREATE INDEX idx_notifications_ts ON notify.notifications (ts DESC);
