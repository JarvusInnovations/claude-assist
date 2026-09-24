---
status: planned
depends: [transcript-chunked-ingest]
specs:
  - specs/behaviors/session-transcript-storage.md
issues: []
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
