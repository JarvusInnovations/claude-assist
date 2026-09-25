---
status: done
depends: [transcript-read-layer]
specs:
  - specs/behaviors/session-transcript-storage.md
issues: []
pr: 242
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
8. The read layer learns `storage = chunked`. This is what actually lets
   `readAround`/`find`/`messageRange`/`since`/`messagesSince`/`rawByteLength`
   resolve to only the chunks (or scalar column) a range touches instead of
   loading the whole transcript — the memory-ceiling criterion deferred from
   [`transcript-read-layer`](transcript-read-layer.md), whose inline backend
   has no choice but to load the full value for these. (`messagesSince` and
   `rawByteLength` were added by the concurrently-landing
   `windowed-session-outlines` (#240); this plan gives both a chunked
   backend, and updates `outline.ts`'s windowed-generation path to read from
   a bounded starting seq instead of always the transcript's start — see
   Notes.)
9. A nightly full-verification task (streamed, one chunk in memory at a time)
   for sessions active in the last day.

## Implements

- **specs/behaviors/session-transcript-storage.md**: the whole rule, except
  existing inline rows (backfill) and phase-2 tiering.

## Approach

New sessions are written chunked from byte zero on first touch — no inline
value ever existed for them, so there's no completeness window to protect.
An inline session that changes on disk instead enters an explicit
`catching_up` state: chunks accumulate from byte zero across as many cycles
as the legacy content requires, while `raw_transcript` stays completely
untouched, and only once chunks reach at least what `raw_transcript` held
(`catchup_threshold_bytes`, frozen at the moment catch-up began) does the row
flip to `chunked` and null `raw_transcript`, in the same transaction as that
cycle's chunk write. This is what the spec's completeness invariant (content
is never covered by neither `raw_transcript` nor chunks at once) actually
requires for a legacy row that can be arbitrarily large. Unchanged legacy
rows are left to the backfill plan.

## Validation

- [x] Integration tests against a real Postgres (throwaway container), since
  CI has no database: append, continuity failure, and budgeted catch-up

- [x] Property test: a split parse equals a full parse, for every aggregate
  and for `tool_calls`
- [x] A growing fixture session ingests only its appended bytes per cycle
  (asserted via bytes read) — unit-tested directly on `readBoundedTail`
  (`chunked-ingest.test.ts`) and confirmed end-to-end in the integration
  suite's append-across-cycles test (the first chunk's byte range is
  unchanged after a second cycle; only new chunks are added)
- [x] A rewritten or truncated file triggers a full re-ingest
- [x] `tool_calls` ids are stable across appends, and the ledger scans only new
  rows — ids verified stable by integration test; the ledger's ascending-id
  cursor scan (`packages/ledger/src/derivation.ts`) is unchanged and its
  correctness now actually depends on `tool_calls` being append-only, which
  this plan makes true (previously the whole index was deleted and
  reinserted every ingest)
- [x] Deployed: the largest live session catches up over several cycles; peak
  RSS stays under the budget-derived ceiling; steady-state cycles on it are
  sub-second
- [x] A satellite on the old CLI still syncs; on the new CLI it pushes the tail
  only
- [x] Around-anchor and grep on the largest archived session stay under a
  memory ceiling (measured) once its `storage = chunked` (deferred from
  [`transcript-read-layer`](transcript-read-layer.md))
- [x] `since`/`messageRange`/`messagesSince`/`rawByteLength` never load a
  chunked session's whole chunk series to answer a bounded range query —
  each resolves to only the overlapping chunks, with seqs rebased back to
  absolute session seqs. Proven three ways: a property-style parity
  integration test across a spread of `fromSeq`/`afterSeq` values on a
  genuinely multi-chunk session, including several that land strictly
  inside a chunk rather than on a chunk boundary; a direct proof that
  corrupting an earlier chunk's content in the database doesn't affect a
  read scoped after it (while a wider range that legitimately needs that
  chunk does see the damage, so the proof isn't vacuous); and
  `outline.ts`'s windowed-generation path verified (via a
  `messagesSince` spy) to read from `min(lastClosedToSeq + 1, the lowest
  from_seq among pending windows)` on a second sweep, not from seq 0.

## Risks / unknowns

- Parser state that assumed whole-file context (chain-root resolution walks
  `parentUuid` back through earlier messages) must fit in the checkpoint.
  Measure the checkpoint size on the largest sessions.
- The spec's Principles require exactly one path for the size limit: this plan
  removes the stopgap skip rather than layering a second limit on it.

## Notes

**Operator verification.**
- Rehearsed on a restored copy of production before deploy, reading real
  transcript files: 8 cycles. A ~400 MB transcript caught up in 64 MiB steps
  over 6 cycles and flipped to chunked on cycle 7. Its chunks matched the
  on-disk file byte for byte (same md5 over ~420 MB), and the retired inline
  value matched the file's prefix exactly. Peak RSS was 1.6 GB, and a steady
  cycle took about 1 s.
- Deployed: the same session caught up in about 26 minutes with server memory
  peaking under 1 GB and no restarts. It idles at about 180 MB.
- Bounded reads on the chunked ~420 MB session: `since`, `messagesSince`,
  `rawByteLength` and around-anchor completed in 120–240 ms with process RSS
  of 80–120 MB.
- Review fixes before merge: byte-accurate `octet_length` for inline sizes and
  the catch-up threshold (`length()` counts characters), a byte-0 push
  baseline for inline sessions, and warnings on continuity mismatch.


- **The incremental parser is independently implemented, not a refactor of
  `parseTranscript`.** `resume`/`feed`/`finalize` live in
  `incremental-parser.ts` with their own from-scratch logic, proven
  equivalent to `parser.ts`'s full-scan algorithm by a property test rather
  than by sharing code. This kept the risk contained to new code, at the
  cost of a second implementation of the token/chain-counting rules to keep
  in sync if that logic ever changes again.
- **Chain tracking is tip-indexed, not chain-root-indexed.** Claude Code's
  transcript format never lets a message reference an already-superseded
  uuid as its parent, so "is this a continuation" only ever needs to check
  the *current tip* of an open chain, not the full history `messagesWithUsage`
  gave the original algorithm. This is what makes `MAX_OPEN_CHAINS` (128)
  bound checkpoint size by concurrency instead of by message count.
- **Two precisely-reproduced postgres.js@3.4.8 parameter-binding quirks**
  (this repo's Bun runtime; not schema/logic bugs), both worked around in
  `chunk-store.ts`. First: `sql(rows, ...cols)` (postgres.js's row-object
  bulk-insert helper) works correctly in its bare/canonical form — `` INSERT
  INTO t ${sql(rows, ...cols)} `` with no literal column list and no explicit
  `VALUES` keyword, which is how the pre-existing `writeToolCalls` actually
  invoked it (confirmed by isolated repro: that exact form still succeeds).
  Combining it with an explicit `VALUES ${sql(rows, ...cols)}` — an early
  draft of `chunk-store.ts`'s own insert — throws `UNDEFINED_VALUE` on the
  same rows over the same connection. **Not** a claim that the pre-existing
  pattern is broken; it isn't. Second: a bound parameter that is a JS array
  of `boolean`s or `Date`s gets its Postgres type inferred from its first
  element as a *scalar* (`boolean`/`timestamptz`), so an explicit
  `::bool[]`/`::timestamptz[]` cast on it fails with "cannot cast type X to
  X[]" (reproduced in isolation for both). Binding ints (cast back to
  boolean in the `SELECT` list) and ISO strings respectively avoids it. Both
  are moot here regardless, since `unnest` was adopted for other reasons
  (bulk-insert efficiency, and each array column being one bound parameter
  rather than one per row sidesteps the 65,534-bind-parameter ceiling
  entirely) — but worth knowing precisely, not overstating, before anyone
  else in this codebase hits either shape. **Distinct** from the
  `UNDEFINED_VALUE` #243 hit in production from: a transcript line missing
  an expected field (e.g. no `timestamp`) yielding a genuine runtime
  `undefined` despite a `string | null` type, bound straight into
  postgres.js. That's a real, different bug class — this plan's fields were
  verified fully-defined (explicit `null`s) when the two quirks above were
  reproduced — but chunk-store.ts's tool_calls writer now defensively
  normalizes every field regardless (`?? null`/`?? ''`), and
  incremental-parser.ts normalizes `tool.name` before it reaches a bind
  parameter, since nothing here should trust a TS type against real
  transcript data any more than #243's code did.
- **`since`'s chunked-tail read had to walk chunks and re-check the actual
  serialized length, not estimate from raw bytes.** The first version
  stopped once accumulated raw bytes reached the char budget, reasoning
  "raw bytes are always >= serialized chars" — true, but the wrong
  invariant: JSON's per-message overhead means raw bytes run several times
  the serialized count, so that threshold under-fetched badly (caught by
  the new parity integration test: a tight budget produced 2 lines on a
  chunked session where identical inline content produced 10). Fixed by
  re-serializing the growing tail slice after each chunk and checking its
  actual length, which can't under-fetch and still stops after the first
  chunk or two in the case that matters (a session that grew by hundreds of
  MB since the cursor).
- **`outline.ts`'s windowed-generation path now reads from a bounded
  starting seq**, not always the transcript's start: `min(lastClosedToSeq +
  1, the lowest from_seq among windows still pending)`. A pending window
  can predate the last closed boundary (carved in an earlier sweep, never
  summarized because the sweep's budget ran out), so existing pending
  windows have to be listed before choosing where to start reading; a
  boundary newly carved this sweep can never need an earlier seq than that
  minimum, since it's built only from messages after `lastClosedToSeq`.
  `isWindowed`'s `WINDOW_MAX_INLINE_BYTES` ceiling — which exists to
  protect the inline backend's whole-column single-pass fallback — no
  longer applies to a chunked session, since nothing on the windowed path
  loads a chunked session's whole chunk series regardless of size.
  `specs/behaviors/session-outlines.md`'s memory-bounds section is updated
  to match.
- **A per-cycle ingest budget smaller than a single JSONL line stalls
  forever** for that session: `readBoundedTail`/`capToBudget` only accept
  complete lines, so a budget that can never fit one full line makes zero
  progress every cycle. Not a concern at the shipped defaults (64 MiB budget
  vs. realistic line sizes in the low KB), but worth knowing if
  `SESSIONS_INGEST_BUDGET_BYTES` is ever tuned aggressively low.
- `sessions.transcript_hash` is vestigial for a chunked session (left as an
  empty string rather than dropped, since the column is `NOT NULL`).
  Change detection no longer uses it; `retire-raw-transcript` or a follow-up
  could drop the column entirely once nothing reads it.

## Follow-ups

- Tracked as: the two "Deployed:" validation criteria (largest live session
  catch-up behavior; peak RSS and steady-state cycle time in production) and
  the around-anchor/grep memory-ceiling *measurement* specifically are
  unchecked — the query-scope guarantee is in place and covered by the
  read-layer parity test, but nothing here profiled actual process memory.
  Whoever deploys this should watch the first few sync cycles on the
  largest local session and note peak RSS in this plan's history (or a
  follow-up plan) once observed.
- Resolved during review, not deferred: `windowed-session-outlines` (#240)
  merged to `main` while this plan was in review, adding
  `TranscriptReader.rawByteLength`/`messagesSince`. This branch was rebased
  onto `main` and both methods, plus the pre-existing `since`/`messageRange`/
  `find`, were given chunked backends in this same PR (see the Validation
  item above and the Notes on the windowed-outline read-bounding fix) —
  nothing was left for a later rebase.
