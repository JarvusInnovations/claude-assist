---
status: in-progress
depends: []
specs:
  - specs/behaviors/session-engagement.md
  - specs/behaviors/session-transcript-storage.md
issues: [259]
---

# Plan: Session engagement

## Scope

1. **Monotone activity ranges.** `mergeActivityRanges` orders the delta's
   timestamps and ignores any at or before the last range's end, so a replayed
   line can no longer pull the end backward. Regression test with a
   resumed-session delta.
2. **Prompt events.** Migration (schema only): `sessions.prompt_events`
   (session_id, seq, ts, head, is_meta, is_sidechain, is_compact_summary,
   queued; unique on session_id + seq), indexed by `ts`, plus the per-session
   backfill marker, cursor and checkpoint. The incremental parser emits one
   event per user turn with text and per queued prompt; chunked ingest appends
   them in the cycle's transaction and a continuity re-ingest replaces them.
3. **Backfill.** A background task for existing sessions with the same
   one-chunk-per-step, byte-budgeted, row-locked handoff as
   `timeline-backfill.ts`. Extract the shared stepping/handoff from that
   module rather than copying it. On finishing a session, rebuild its
   `activity_ranges` from all prompt-event timestamps and reset
   `parse_checkpoint.lastActivityEnd`.
4. **Classifier.** A pure function (event facts + pattern lists → human, or
   automated with the deciding rule). Built-in markers in code; instance
   patterns from `SESSIONS_AUTOMATED_PROMPT_PATTERNS`, compiled once at plugin
   setup (an invalid pattern fails startup, naming it).
5. **Engagement computation.** Pure functions: blocks from timestamps, gap
   merge, clamp to now, split at local midnight in an IANA zone, minutes per
   day. No database access; the route owns the query.
6. **`GET /sessions/engagement`** per the spec, including parameter
   validation, the `SESSIONS_OWNER_TZ` fallback and `pending_sessions`.
7. **CLI.** `sessions-axi engagement --from --to [--tz]` (`tz` sent only when
   passed; the server resolves `SESSIONS_OWNER_TZ` otherwise); `activity` help text stops
   suggesting it answers "how much time on X?". Rebuild bundles and SKILL.md.

## Implements

- **specs/behaviors/session-engagement.md**: all of it.
- **specs/behaviors/session-transcript-storage.md**: prompt events join the
  incrementally derived set.

## Approach

Order is 1 → 2 → 3 → (4, 5) → 6 → 7; item 1 is independently shippable and
goes in its own commit first.

One query serves the endpoint: prompt events with `ts` in the window widened
by `block_minutes + gap_minutes` on the leading edge, joined to their
sessions. Classification, pooling and bucketing run in JS over those rows. A
92-day window is tens of thousands of small rows at most.

Local-midnight instants come from `Intl.DateTimeFormat` with the requested
zone; no date library is added.

## Validation

- [ ] A session whose only user turns are loop firings or task notifications
  reports 0 human minutes and is still listed, with `automated_by` counts
- [ ] No range has `end < start` after a delta containing timestamps older
  than the last range end (unit), and after backfill on a real database no
  stored range does (query)
- [ ] Two parallel sessions with interleaved human prompts in one hour count
  that hour once in `envelope_minutes`
- [ ] Day bucketing honors `tz`: a block crossing local midnight splits
  between the two days, including across a DST transition; the same day
  returns the same figures from two different windows
- [ ] Prompt events from split feeds equal those from one full feed; ingest
  appends without rewriting; continuity re-ingest replaces
- [ ] Backfill/live-ingest handoff race covered by an integration test, as
  for the context timeline
- [ ] Adding an instance pattern changes past days' figures with no re-ingest
- [ ] Bad `from` / `to` / `tz` / window / minutes each return 400 naming the
  parameter; the window 400 states the cap and requested span; no `tz` and no
  `SESSIONS_OWNER_TZ` is a 400, and `tz` overrides the env value
- [ ] After backfill, every session's last prompt event is within its
  `ended_at` (issue #259 item 4: no trailing turns skipped)
- [ ] `bun test`, `bun run check:skills`, `bun run type-check:axi` pass

## Risks / unknowns

- **Why old timestamps appear in a delta** is inferred (resume/fork replay),
  not observed here. The monotone rule is correct regardless of cause.
- **Issue item 4** (last range ending weeks before the last turn) is assumed
  to be a symptom of the inverted merge. The post-backfill validation above
  tests that assumption; if it fails, the checkpoint is skipping lines and
  that is a separate defect.
- **Marker coverage.** The built-in list is the issue's list. Real corpora
  may show other client-emitted wrappers; because classification is at read
  time, adding one is a code change with no data migration.
- **A second set of backfill columns** on `sessions.sessions`. Acceptable for
  two derivations; a third should move the bookkeeping to its own table.
