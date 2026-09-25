---
status: done
depends: [transcript-chunk-backfill]
specs:
  - specs/behaviors/session-transcript-storage.md
issues: []
pr: 245
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

- [x] Migration drops the column; no code references it
- [x] Full test suite and a deployed smoke test of every transcript route pass

## Notes

**Operator verification.**
- Migration 017 was rehearsed on the restored production copy (all rows
  chunked). After it, the new code synced (first cycle 7.6 s at 401 MB peak,
  then 0.9 s steady) and read the largest session in 123 ms at 81 MB.
- Deployed after production reported 0 remaining and 0 failures.
- Smoke test via the sessions CLI against production: search, per-session
  grep with windowed matches, and session details all returned correct data.


- **`backfillContextWindow` removed, not reimplemented.** It only ever
  targeted `raw_transcript IS NOT NULL AND context_final_tokens IS NULL`
  rows — sessions ingested before migration 013 added the context-window
  columns. Once `raw_transcript` is gone nothing matches that predicate
  anymore, and ordinary chunked ingest already populates the context columns
  as it parses. There was no remaining job to preserve.
- **`specs/behaviors/session-sync-memory-bounds.md` left untouched.**
  Re-read end to end: none of its rules (atomic transaction, batched
  `tool_calls` insert, stat-only unchanged-transcript check, systemd memory
  caps) reference `raw_transcript`/`storage`/`catching_up` — an earlier plan
  already wrote it purely in terms of the chunked ingest cycle. Its owning
  plan (`plans/session-sync-memory-bounds.md`) is also still
  `status: in-progress` with unchecked "Deployed" validation boxes, so per
  the plan protocol ("flag the owner rather than rewriting under them") it
  was left alone rather than folded or slimmed.
- **Migration 017's precondition is self-checking, not trust-based.** A `DO`
  block re-verifies every row is `storage = 'chunked'` /
  `raw_transcript IS NULL` and `sessions.backfill_failures` is empty, and
  `RAISE EXCEPTION`s (never recording the migration, leaving the schema
  untouched) if not. Verified against a throwaway Postgres: aborts with an
  inline row present, succeeds once fully converted, and the resulting
  schema passes the full chunked-ingest integration suite plus a live-route
  smoke test (session list/detail/transcript) — see PR #245's description
  for the full account.
- **The validation box for the deployed smoke test is left unchecked
  deliberately.** This PR must not be deployed until the production backfill
  reports `remaining=0, failures=0` (migration 017 enforces this itself, but
  there's no reason to race it) — the deployed half of that criterion can
  only close out after that deploy actually happens.

## Follow-ups

None.
