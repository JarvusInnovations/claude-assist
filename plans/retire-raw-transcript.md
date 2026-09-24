---
status: planned
depends: [transcript-chunk-backfill]
specs:
  - specs/behaviors/session-transcript-storage.md
issues: []
---

# Plan: Retire the inline raw_transcript column

## Scope

1. Drop `sessions.raw_transcript` and the `storage` discriminator, and remove
   the read layer's inline branch.
2. Remove the reparse scripts' direct column access (they read through the
   read layer by now).
3. Amend `specs/behaviors/session-sync-memory-bounds.md`: the size-skip rule is
   superseded by the ingest budget. Fold what survives (the transaction, the
   batched `tool_calls` insert, the unit memory caps) into this spec, or keep
   it as a slimmed behavior spec.

## Implements

- **specs/behaviors/session-transcript-storage.md**: chunks are the only
  storage.

## Validation

- [ ] Migration drops the column; no code references it
- [ ] Full test suite and a deployed smoke test of every transcript route pass
