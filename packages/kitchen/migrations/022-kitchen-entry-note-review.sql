-- Unreviewed entry notes (specs/modules/kitchen.md § Unreviewed entry notes).
--
-- A cook-mode submission's free-text note routinely names something the computed
-- panel does not account for — a condiment, a splash of oil, an extra the
-- component list never anticipated. The note is preserved, so the record is
-- honest; the totals silently are not.
--
-- Rather than add a structured "extras" input nobody would use at eat time, the
-- gap is made VISIBLE and reconciled asynchronously, mirroring the needs-info
-- flow that already exists for inventory items.

ALTER TABLE kitchen.entries
    ADD COLUMN notes_reviewed BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill deliberately marks ALL existing entries reviewed.
--
-- The alternative — flagging every historical noted entry — would produce a
-- backlog of hundreds on day one, and a queue nobody can realistically drain is
-- a queue everyone learns to ignore. The surface is only useful if a non-zero
-- count means "something new needs a look". Defaulting the column to TRUE makes
-- the backfill implicit: only entries written after this migration, by a caller
-- that explicitly says a human supplied the note, start unreviewed.
--
-- NOTE: the DEFAULT stays TRUE for exactly that reason. "Nothing to review" is
-- the correct resting state; being unreviewed is an explicit assertion that a
-- human said something, made by the ingest path that knows.

-- Partial index: the questions surface reads only the unreviewed rows, and they
-- are the rare case.
CREATE INDEX idx_kitchen_entries_notes_unreviewed
    ON kitchen.entries(logged_at)
    WHERE notes_reviewed = FALSE;

COMMENT ON COLUMN kitchen.entries.notes_reviewed IS
    'FALSE only when a HUMAN supplied the note and nobody has reconciled it against the panel yet. Agent-composed notes (e.g. a worksheet''s measured-provenance manifest) are not human statements and never flag.';
