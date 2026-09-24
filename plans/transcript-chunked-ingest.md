---
status: planned
depends: [transcript-read-layer]
specs:
  - specs/behaviors/session-transcript-storage.md
issues: []
---

# Plan: Chunked, incremental transcript ingest

## Scope

Store new and changed sessions as append-only chunks, ingested incrementally.
Existing rows stay on `raw_transcript` until the backfill plan converts them.

In scope:

1. Migration: `sessions.transcript_chunks` (session, seq, byte range, message
   range, content, hash), plus on `sessions.sessions`: `storage`
   (`inline` | `chunked`), `ingested_bytes`, `parse_checkpoint` (jsonb); and the
   message index `sessions.transcript_messages` (session, seq, uuid,
   chunk_seq), which the read layer uses for anchors and message ranges on
   chunked sessions.
2. Incremental parser: `parseTranscript` split into
   `resume(checkpoint) → feed(lines) → checkpoint + deltas`. A property test
   checks that N-way split parsing equals a single full parse.
3. Local sync: continuity check → read only `[ingested_bytes, EOF)` (capped by
   `SESSIONS_INGEST_BUDGET_BYTES`, cut at the last newline) → chunk
   (`SESSIONS_CHUNK_MAX_BYTES`) → incremental parse → one transaction that
   appends chunks, merges aggregates, appends `tool_calls`, and advances
   `ingested_bytes` and the checkpoint. A failed continuity check re-ingests
   from zero.
4. Change detection uses size and the last-chunk hash, not a whole-file MD5.
   Unchanged sessions cost a `stat`.
5. Push protocol: the inventory response carries `ingested_bytes` and the
   last-chunk hash; the push CLI sends the tail only. The server accepts both
   the old and new payloads during rollout, and a CLI version bump ships
   together with the vendored skill.
6. Retire the `SESSIONS_MAX_FILE_SIZE` skip: the per-cycle budget replaces it,
   and sessions skipped for size become ingestable.
7. Bounded `search_text` (the most recent user messages within the
   `tsvector` limit).
8. The read layer learns `storage = chunked`.
9. A nightly full-verification task (streamed, one chunk in memory at a time)
   for sessions active in the last day.

## Implements

- **specs/behaviors/session-transcript-storage.md**: the whole rule, except
  existing inline rows (backfill) and phase-2 tiering.

## Approach

New sessions, and any inline session that changes, are written chunked from
byte zero on first touch after deploy. That touch also clears their
`raw_transcript` in the same transaction. Unchanged legacy rows are left to
the backfill plan.

## Validation

- [ ] Integration tests against a real Postgres (throwaway container), since
  CI has no database: append, continuity failure, and budgeted catch-up

- [ ] Property test: a split parse equals a full parse, for every aggregate
  and for `tool_calls`
- [ ] A growing fixture session ingests only its appended bytes per cycle
  (asserted via bytes read)
- [ ] A rewritten or truncated file triggers a full re-ingest
- [ ] `tool_calls` ids are stable across appends, and the ledger scans only new
  rows
- [ ] Deployed: the largest live session catches up over several cycles; peak
  RSS stays under the budget-derived ceiling; steady-state cycles on it are
  sub-second
- [ ] A satellite on the old CLI still syncs; on the new CLI it pushes the tail
  only

## Risks / unknowns

- Parser state that assumed whole-file context (chain-root resolution walks
  `parentUuid` back through earlier messages) must fit in the checkpoint.
  Measure the checkpoint size on the largest sessions.
- The spec's Principles require exactly one path for the size limit: this plan
  removes the stopgap skip rather than layering a second limit on it.
