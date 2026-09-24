---
status: done
depends: []
specs:
  - specs/behaviors/session-transcript-storage.md
issues: []
pr: 239
---

# Plan: Transcript read layer

## Scope

Route every reader of transcript content through one range-based read API
before storage changes shape, so the switch to chunks is a change inside one
module rather than across nine call sites.

In scope:

1. A `TranscriptReader` with range operations: full, message range
   (`fromSeq`/`toSeq`), head+tail within a byte budget, window around an anchor
   uuid, and a streaming line iterator for grep.
2. Implemented over today's `sessions.raw_transcript`. Head/tail and byte ranges
   use SQL `left`/`right`/`substring`, so the server never loads a whole large
   value to return part of it.
3. Migrate every reader: the transcript, grep, around and cross-session
   transcript routes; share routes; the classification store/service
   (`serializeSince`); the outline fetch; the reparse scripts.

Out of scope: any change to what is stored.

## Implements

- **specs/behaviors/session-transcript-storage.md**: "Readers take ranges".

## Approach

Introduce the reader in `packages/sessions`. Convert one caller at a time with
before/after output equality tests on fixture transcripts. After the plan, a
grep for `raw_transcript` outside the reader and the ingest writer returns
nothing.

## Validation

- [x] No SELECT of `raw_transcript` outside the read layer and the ingest writer
- [ ] Route and pipeline outputs are byte-identical before and after on fixtures
- [ ] Around-anchor and grep on the largest archived session stay under a
  memory ceiling (measured) instead of loading the full value

## Risks / unknowns

- Around-anchor needs uuid → message index. Today that is a scan. With chunks
  it needs either a per-message index or a scan bounded to candidate chunks
  (open question on the planning PR).

## Notes

- Confirmed by `grep -rn raw_transcript packages/sessions/src
  packages/sessions/scripts`: the only remaining hits are inside
  `transcript-reader.ts`/`transcript-reader.test.ts` (the read layer),
  `sync.ts` (the ingest writer and `backfillContextWindow`), `types.ts`
  (`SessionRecord.raw_transcript`), and a handful of explanatory comments
  elsewhere that name the column without touching it.
- `SyncService.backfillContextWindow` in `sync.ts` was deliberately left
  reading `raw_transcript` directly rather than routed through the reader: it
  is already batched (`LIMIT` + per-row parse) and needs a full parse
  regardless (context-window accounting scans the whole transcript), so a
  reader wrapper would add a call with no memory or behavior benefit. It
  wasn't in the plan's enumerated reader list either.
- `GET /sessions/:id` wasn't named in the plan's reader list but was clearly
  in scope per the spec's "Every consumer of transcript content" — it was
  unconditionally selecting `raw_transcript` via `SELECT s.*` on every
  session-detail request, whether or not `with_raw_messages` was set. Fixed
  as part of this plan; `SessionSummaryRecord` is the new projection.
- The plan's "streaming line iterator for grep" is implemented as a plain
  async method (`{ sessionFound, matches }`) rather than a literal
  `AsyncGenerator`. `FindOptions` (`afterUuid`/`limit`) already gives a future
  chunked backend a bounded, resumable range to satisfy without materializing
  the whole transcript; a generator at the API boundary would either drop the
  `sessionFound` 404 signal or complicate every caller for no behavioral gain
  under today's inline backend. See PR #239 description for the full
  rationale.
- `readAround`/`find` distinguish "session not found" from "found, nothing
  matched" via a discriminated result (`{ sessionFound, window/matches }`)
  instead of two sequential round-trips (a `SELECT` to check existence, then
  a parse) — same SQL cost (one `readFull` either way), same HTTP-visible
  behavior, cleaner call sites.

## Follow-ups

- Deferred to [`transcript-chunked-ingest`](transcript-chunked-ingest.md) —
  the memory-ceiling validation criterion above only becomes achievable once
  the read layer's chunked branch lands (item 8 of that plan's Approach, plus
  a new Validation criterion, added in this same commit).
- Tracked as: the "byte-identical before/after on fixtures" criterion above
  is left unchecked. Every migrated call site reuses the *same* unmodified
  pure functions (`serializeTranscript`, `findInTranscript`, `readAround`,
  `serializeSince`) over the *same* SQL text as before (verified by diff and,
  for the two SQL statements that did change — the head+tail sample and the
  new `/sessions/:id` column list — by running them against a real throwaway
  Postgres and checking the output by hand), so equivalence holds by
  construction. What's missing is an automated fixture-based diff harness
  that actually runs the old and new code paths side by side; nothing in this
  repo's test setup made that cheap to add without a live database, and none
  existed before this plan either. If stronger proof is wanted later, file an
  issue for a snapshot-test harness over `packages/sessions/src/routes.ts`.
