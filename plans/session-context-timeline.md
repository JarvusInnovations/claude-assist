---
status: done
depends: []
specs:
  - specs/behaviors/session-context-window.md
issues: []
pr: 253
---

# Plan: Session context timeline

## Scope

1. Migration: `sessions.context_events` (session_id, seq, ts, kind
   `reading` | `compaction`, tokens, pre_tokens, post_tokens, trigger), indexed
   by (session_id, ts); a per-session marker for timeline backfill coverage.
2. The incremental parser emits readings (the same main-chain,
   `isFirstInChain` rule as `context_final_tokens`) and `compact_boundary`
   compactions. Chunked ingest appends them in the cycle's transaction, and a
   continuity re-ingest replaces them with the chunks.
3. A background backfill for existing sessions: feed chunks through the
   incremental parser one at a time under a per-run byte budget, resumable.
   It must be fast per step so it never stalls startup (see ca#248); migrations
   add only schema.
4. `GET /sessions/:id/context-timeline`: active-time axis segments (gaps over
   30 min collapsed), downsampled readings (≤ ~600, bucket max plus last),
   every compaction, and the limit.
5. Admin chart (inline SVG, no new chart dependency) under the Context Window
   card, full width: token line, limit ceiling when known, compaction markers
   with drop annotation, gap breaks, day labels, hover readout.

## Implements

- **specs/behaviors/session-context-window.md**: the Timeline section.

## Validation

- [x] Parser test: readings and compactions from split feeds equal those from
  one full feed
- [x] Ingest appends events without rewriting earlier ones; continuity
  re-ingest replaces them
- [x] Downsampling keeps the global peak and every compaction; gap collapse and
  day segments unit-tested
- [x] Backfill covers existing sessions with bounded memory (measured on the
  largest session)
- [x] Chart renders for a one-day session and a multi-week session — verified
  via unit-tested layout math (segment weighting, gap collapse, day
  boundaries) and a clean admin build, not an in-browser screenshot; see
  Follow-ups.

## Notes

- **Live-ingest/backfill handoff, precisely.** `sessions.sessions` gains
  `timeline_backfill_done` (bool), `timeline_backfill_next_chunk_seq` (int),
  `timeline_backfill_checkpoint` (jsonb — an incremental-parser checkpoint
  independent of the live-ingest `parse_checkpoint`). A brand-new session sets
  `timeline_backfill_done = true` at INSERT (no backlog to backfill). A `fresh`
  re-ingest of an existing session recomputes the whole transcript in one
  `feed()` call (see `sync.ts#runCycle`), so it writes the complete
  readings/compactions itself and also sets the flag true, resetting the
  cursor. An ordinary append cycle writes its own events **only if** the flag
  is already true; the check (`SELECT timeline_backfill_done ... FOR UPDATE`)
  is the *first* statement to touch the session row in that transaction. The
  backfill task (`timeline-backfill.ts`) walks already-stored
  `transcript_chunks` one row at a time from its cursor, and when it finds no
  chunk beyond the cursor, takes the same row lock before flipping the flag.
  Whichever of {a live-ingest append, backfill's "done" decision} commits
  first is what the other sees — Postgres's row lock is the serialization
  point, not an in-process flag (per specs/behaviors/scheduled-work-leases.md:
  "the database is the coordination primitive"). Verified against a real
  throwaway Postgres, including the specific race where a live append lands
  mid-backfill (`timeline.integration.test.ts`).
- Backfill needs no lease beyond that row lock — the scheduler's own advisory
  lock (`sessions:timeline-backfill`) already keeps it single-flight, and its
  progress (cursor + checkpoint) is durable per session between runs.
- Endpoint downsampling is done in JS after one bounded SQL fetch, not in SQL.
  Justified by measurement: the largest real session (508 MB transcript,
  ~134K transcript messages, ~18.5K tool calls) implies a reading count in the
  low tens of thousands — small, derived, per-call rows, nothing like loading
  transcript content. Revisit if a session's call count grows an order of
  magnitude past that.
- Segment/gap layout math for the admin chart lives in
  `apps/admin/src/lib/timeline-layout.ts`, kept pure and unit-tested with
  `bun test` (added a `test` script to `apps/admin/package.json`, which didn't
  have one before — it now participates in the root `bun run test`).

## Follow-ups

- Nobody has opened the chart in a browser against a real one-day session and
  a real multi-week session. The geometry is unit-tested and the build is
  clean, but visual review (spacing, label collisions on a dense session,
  dark-mode contrast) is still open.
- `SESSIONS_TIMELINE_BACKFILL_BUDGET_BYTES` (16 MiB default) and the `*/2 * * *
  *` cadence are unmeasured against the real backlog (2,697 sessions in the
  live DB, one of them 508 MB) — fine to tune once it's running against real
  data and the backfill's pace is observable.
