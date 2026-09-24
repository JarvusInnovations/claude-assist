---
status: done
depends: [transcript-read-layer]
specs:
  - specs/behaviors/session-transcript-storage.md
  - specs/behaviors/session-outlines.md
issues: []
pr: 240
---

# Plan: Windowed outlines for long-running sessions

## Scope

Today an outline over a long session keeps only the first and last N
characters and drops the middle. For a persistent bot, the middle is most of
the record. Long sessions get **rolling window summaries** instead.

In scope:

1. Sessions over an outline threshold are divided into windows (by message
   range, capped by size or by time span, whichever comes first). Each window
   is summarized once, when complete, and stored with its message range
   (`sessions.outline_windows`).
2. The session outline is composed from the window summaries (summary of
   summaries) and refreshed only when new windows close. The open tail window
   is summarized at most once per sweep.
3. Short sessions keep the current single-pass outline.
4. `sessions-axi` exposes the window summaries in `details`.

## Implements

- **specs/behaviors/session-transcript-storage.md**: truncation is a reader
  choice made over the complete record.
- A new outline behavior spec is written as part of this plan. The windowing
  rule belongs there, not in the storage spec.

## Validation

- [x] Content from the middle of a multi-week session appears in its outline
  — `buildComposePrompt` includes every window's summary in chronological
  order (`outline-windows.test.ts`), and an end-to-end `OutlineService` test
  over a 500-message backlog confirms all windows get summarized and folded
  into the composed outline across successive sweeps (`outline.test.ts`).
  Not verified against a live model (none was called, per instructions) —
  the model's summarization quality itself is unverified, only that its
  output for every window reaches the compose step.
- [x] A closed window is never re-summarized; the model cost per sweep on a
  growing session is bounded by new windows — `OutlineWindowStore`'s
  claim/complete cycle sends a closed window terminal (`summarized`) on
  success, and a claim on an already-summarized or already-claimed row is a
  no-op (verified under a real concurrent race in
  `outline-windows.test.ts`, and end-to-end: once a session is fully caught
  up it drops out of the sweep selection query entirely, so its windows are
  never even considered again). The per-sweep sweep-cap budget bounds
  spend to new/still-pending windows only.

## Risks / unknowns

- Model cost of the initial backfill of windows for existing long sessions —
  resolved to an estimate method (not run against a real model):
  1. `SELECT count(*) FROM sessions.sessions WHERE message_count >
     :thresholdMessages OR length(raw_transcript) > :thresholdBytes` gives
     the number of sessions that will windowize on first sweep.
  2. For each, `ceil(message_count / maxMessages)` (or the byte/time-span
     equivalent, whichever binds first) estimates its window count; sum
     across matching sessions for the one-time backfill total.
  3. Multiply by an assumed tokens/window. `OutlineService`'s own comments
     already establish ~3.33-3.5 chars/token for this corpus; a window
     capped at `maxBytes` (500,000 raw bytes) serializes to well under
     `TRANSCRIPT_PROMPT_CHAR_BUDGET` (300,000 chars) ≈ 85-90K tokens input
     per window at the high end (typically far less — most windows close on
     message count or span, not the byte cap), plus a small fixed output
     (window summaries are one paragraph).
  4. Total backfill cost ≈ `total_windows × avg_input_tokens_per_window ×
     extract-tier input price`, plus one `compose` call per session
     (chronological summaries only, much smaller). At the default
     `sweepCap` of 20 windows/hour, backfill of even a large archive spreads
     over days rather than bursting — divide the total by `sweepCap × 24` for
     an expected days-to-catch-up figure.
  This estimate should be run with real `message_count`/`raw_transcript`
  distributions from the target instance before raising `sweepCap` or
  lowering the thresholds materially.

## Notes

- **Why `OutlineWindowStore` hand-rolls its claim/lease instead of reusing
  `packages/core`'s `createLeaseQueue`**: that helper's `complete()` never
  resets `attempts`, which is correct for a table of one-shot rows but wrong
  for the open tail window, which is claimed and completed repeatedly across
  a session's whole life — five successful completions would otherwise
  permanently exhaust it. Documented in the spec and in a code comment on
  `OutlineWindowStore` itself so a future reader doesn't "fix" this into a
  bug by switching it over.
- **Budget is per-session-walk, not a single global claim query.** The
  design sketch in the plan's Approach discussion (device brief) described a
  global `SELECT ... LIMIT sweepCap` claim across the whole table. The
  shipped design instead threads a shared counter through the existing
  per-session sweep loop, claiming a session's own windows oldest-first as
  it's walked. Same atomicity guarantee per row, same global spend cap per
  sweep; not a strict cross-session priority queue (a session earlier in the
  walk order — the sweep already sorts by `started_at DESC` — can exhaust
  the budget before a session with a larger closed-window backlog is
  reached). Considered adequate: unclaimed windows simply carry to the next
  sweep, and the simpler design avoids a second table-wide query shape to
  keep in sync with the per-row claim.
- **Windowing decision is `message_count OR raw byte length`, checked in that
  order.** `message_count` is already on the row selected by the sweep query
  (free); `rawByteLength` only runs (one scalar SQL read, never a content
  fetch) for a session that's short on messages but could still be large.
- **`outline_windows_hash` is a new column, not a repurposing of
  `outline_hash`.** Tried reusing `outline_hash` first (it already has the
  right shape — a signature of "what produced the current outline") but a
  windowed session's `transcript_hash` changes continuously while active,
  which would make the existing `outline_hash IS DISTINCT FROM
  transcript_hash` pending-query permanently true for every active windowed
  session regardless of whether recomposition is actually needed. The
  separate column keeps that query meaningful for both paths.
- Migration numbering: 015, deliberately independent of the concurrently
  in-flight 014 (`transcript-chunked-ingest`) — no shared tables/columns, and
  the throwaway-Postgres verification applied 001-013 + 015 with 014 absent,
  per the concurrency note, without incident.

## Follow-ups

- Issue [#241](https://github.com/JarvusInnovations/claude-assist/issues/241)
  — the manual-trigger outline route (`POST /sessions/outlines`) bypasses the
  scheduler's advisory lock, a pre-existing gap at the whole-session
  short-pass level (not introduced by this plan; windowed sessions now have
  real per-row claim/lease protection at the window level via
  `OutlineWindowStore`, but the top-level sweep selection still doesn't).
