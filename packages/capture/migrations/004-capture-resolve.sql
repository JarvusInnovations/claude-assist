-- Resolve: a terminal state for held captures.
--
-- Captures parked in awaiting_review (or stranded in awaiting_executor)
-- previously had no exit — the review queue could only grow. `resolved`
-- records that a human (or their agent) synthesized the item outside the
-- automated executors, with an optional note saying where it went.

ALTER TYPE capture.capture_status ADD VALUE IF NOT EXISTS 'resolved';

ALTER TABLE capture.captures
    ADD COLUMN IF NOT EXISTS resolution TEXT,
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
