---
status: done
depends: [transcript-chunked-ingest]
specs:
  - specs/behaviors/session-transcript-storage.md
issues: []
pr: 244
---

# Plan: Backfill legacy transcripts into chunks

## Scope

Convert every remaining `storage = inline` row to chunks, then reclaim the
space the inline values held.

In scope:

1. A resumable background task: pick N inline rows per run, ordered smallest
   first so progress is visible early. Read `raw_transcript` in byte ranges,
   write chunks and the checkpoint, and verify that the reassembled chunks equal
   the original (length and hash). Then set `storage = chunked` and null
   `raw_transcript`, all in one transaction per session.
2. Rows whose on-disk file is larger than the archived value (sessions the
   stopgap skipped) continue from the file through normal incremental ingest.
3. Progress endpoint or log (converted / remaining / bytes), and a stop switch.
4. Space reclamation: once all rows are converted, reclaim the dead TOAST space
   with `VACUUM FULL sessions.sessions`, run by the operator in a quiet window
   (an exclusive lock for a few minutes at this size). Verify that the database size drops and that the
   next restic snapshot shrinks.

## Implements

- **specs/behaviors/session-transcript-storage.md**: completeness for sessions
  archived before chunking.

## Approach

Throttle with a per-run byte budget like ingest so the backfill never competes
with sync for memory. Rows that fail verification stay inline and are
reported, never partially converted.

## Validation

- [ ] A verified backup snapshot exists from immediately before the run

- [ ] Every row is `chunked`, and `raw_transcript` is null everywhere
- [ ] Spot-check: for a sample across size buckets, a transcript served via
  the read layer is byte-identical to a pre-migration dump
- [ ] Database and backup size measured before and after, recorded in Notes

## Risks / unknowns

- `VACUUM FULL` takes an exclusive lock for its duration, which blocks sync and
  reads. Stop the server's sync (or the server) for the few minutes it takes.
- Transcripts older than the local retention window exist only in the
  database, so backfill verification is the only safeguard for them. Take a
  restic snapshot immediately before starting.

## Notes

All four Validation criteria are operator/production steps this PR's code
deliberately does not perform — a subagent built this in an isolated worktree
with no access to the production database or backup tooling. Left unchecked;
see the operator runbook in PR #244's description for the exact sequence
(backup → enable/run → watch `GET /sessions/backfill/status` → spot-check →
`VACUUM FULL`). The code itself is built, tested against a throwaway Postgres,
and does not run `VACUUM` anywhere.

Design decisions worth carrying forward:

- **`raw_transcript` byte ranges are read via SQL
  (`substring(convert_to(raw_transcript,'UTF8') FROM ... FOR ...)`), never a
  file** — the whole reason this plan exists separately from local sync's own
  inline→catching_up path is that many of these sessions' files are already
  gone. `chunked-ingest.ts`'s `cutAtLastNewline` is reused unchanged to cut the
  returned byte window to the last complete line.
- **Verification runs entirely in SQL** (`octet_length`/`md5` on
  `raw_transcript` vs. `SUM(octet_length(content))`/
  `md5(string_agg(content,'' ORDER BY seq))` on `transcript_chunks`) so a
  400 MB transcript's bytes never have to land on the app heap just to compare
  them, and the compare-then-flip happens in the same transaction as the flip
  itself.
- **The local-sync race is closed with a `SELECT ... FOR UPDATE` row lock**
  (`chunk-store.ts#getChunkStateForUpdate`), the same row local sync's own
  `writeIngestCycleTx` UPDATE already locks implicitly — not a dedicated
  advisory lock, since this needs no new lock namespace. A new
  `backfill_owned` column (migration 016) disambiguates which of the two
  possible producers of a `catching_up` row this task may safely resume; a
  `catching_up` row local sync produced from a still-present, grown file is
  left alone.
- **Item 2 of Scope** ("rows whose on-disk file is larger than the archived
  value... continue from the file through normal incremental ingest") was
  already true before this plan — it's `SyncService#ingestLocalFile`'s
  existing inline→catching_up behavior from `transcript-chunked-ingest`
  (#242). Nothing needed to change there; this plan's backfill only ever
  claims rows sourced from `raw_transcript`, never a file.
- **The "stop switch" (Scope item 3)** is `SESSIONS_BACKFILL_ENABLED`, which
  requires a restart/redeploy to flip — there is no live pause-without-restart
  endpoint, matching every other scheduled task in this codebase (sync,
  outlines, classification all work the same way). If an operator ever needs
  to pause mid-run without a redeploy, that's a new capability, not something
  this plan promised.

## Follow-ups

None.
