---
status: planned
depends: [session-engagement]
specs:
  - specs/behaviors/session-engagement.md
issues: []
---

# Plan: Engagement blocks, day rollover and source freshness

## Scope

A time-tracking reconcile consumer can now read human engagement totals from
`GET /sessions/engagement`, but still falls back to local transcript files for
three things the response does not carry:

1. **The blocks behind the totals.** The consumer logs meetings as fixed
   entries and needs engaged time *outside* them, which means intersecting
   engagement with its own meeting intervals. Totals cannot be intersected.
2. **A day that starts after midnight.** Work at 01:00 belongs to the day that
   was ending. Splitting at midnight forces the consumer to re-bucket, which it
   cannot do from per-day totals.
3. **Whether the figures are complete.** A machine that has not pushed reads
   exactly like a person who did no work. The consumer needs to know which
   machine is behind and up to when everything is in.

In scope:

1. **`day_start`.** Parse and validate `HH:MM`; compute each logical day's
   boundaries as the wall-clock `day_start` on its date in the zone (gap → first
   instant after; overlap → first occurrence). Replace the local-midnight split
   with a split at those boundaries. Echo `day_start`, add `starts_at` /
   `ends_at` per day.
2. **`include=blocks`.** Keep the merged, clipped blocks the computation
   already builds for the envelope and per project, and return them as
   `{ start, end }` ISO instants. Validate `include`.
3. **Clean sync instant.** Migration: `sessions.machines.last_clean_sync_at
   TIMESTAMPTZ NULL`. `processPush` and `syncLocal` set it to the cycle's
   start time only when the cycle finished with no errors (`last_sync_at`
   keeps its current meaning). Check the push client completes a cycle on its
   cadence with an empty payload; if it skips empty pushes, change it to send
   one (or a lightweight `POST /sessions/push` with no sessions, which already
   validates).
4. **`sources` and `complete_through`.** One query: machines with a session
   whose activity overlaps `[from − 30 days, to]`, with `last_clean_sync_at`
   and `max(prompt_events.ts)` from that machine's sessions.
   `complete_through` = min `last_clean_sync_at`, or `null` if any is null.
5. **CLI.** `sessions-axi engagement` gains `--day-start` and `--blocks`
   (sent only when passed) and prints `complete_through` with the oldest
   source in its header. Rebuild bundles and SKILL.md.

6. **Subagent hand-backs are automated.** A background subagent's final
   report is delivered into the parent session as a queued command that
   starts with `<agent-message`, with no origin kind and no queue priority.
   None of the classification rules catches it today, so each hand-back reads
   as a human prompt. An orchestrating session that fans out many subagents
   then reports human engagement for hours in which nobody typed. Add the
   marker as a built-in rule (`handback`) in `prompt-classifier.ts`.
   Classification runs when engagement is read, over the stored head, so
   past windows correct themselves on deploy with no migration. Add a
   regression test: a session whose only queued prompts
   are hand-backs and task notifications reports 0 human minutes.

## Implements

- **specs/behaviors/session-engagement.md**: *Day boundary*, *Time blocks*,
  *Source freshness*, and the added query parameters and response fields.

## Approach

Order: 1 → 2 → 3 → 4 → 5. Items 1 and 2 touch only `engagement.ts` (pure) and
the route, and ship together; 3 and 4 add the migration and the sync change.

- **`engagement.ts`.** `localDays(fromMs, toMs, tz)` takes a
  `dayStartMinutes` argument and returns `{ date, startMs, endMs }` cut at the
  wall-clock boundary. The existing `wallClockAsUtc` helper converts; resolve a
  boundary by searching the instant whose wall clock first reaches
  `day_start` on that date, which handles both DST cases without a date
  library. The rollup already holds merged block lists before summing minutes;
  return them alongside the figures instead of discarding them.
- **`routes.ts`.** Widen the leading query margin by the `day_start` offset so
  a day's figures still do not depend on the window. Add the freshness query.
  Return blocks only when requested to keep the default payload unchanged.
- **Sync.** `updateMachineSync(machineId, clean: boolean)`; both callers pass
  `result.errors.length === 0` measured for that cycle.

## Validation

- [ ] `day_start=04:00`: a prompt at 01:30 on the 10th counts toward the 9th;
  with the default it counts toward the 10th
- [ ] Across spring-forward and fall-back, a `day_start` inside the skipped or
  repeated hour resolves as specified; the affected days are 23h and 25h and
  every block minute is counted exactly once
- [ ] The same day returns the same figures from two different windows, with
  a non-default `day_start`
- [ ] With `include=blocks`, the day's blocks never overlap and sum to
  `envelope_minutes` (before rounding); project blocks may overlap across
  projects, never within one; a block crossing a boundary appears as two
  clipped pieces; no block extends past the request time
- [ ] Without `include`, the response is byte-identical in shape to today's
  apart from the new top-level fields
- [ ] A push with one failing session advances `last_sync_at` but not
  `last_clean_sync_at`; a clean empty push advances both
- [ ] `complete_through` is the oldest covering machine's clean sync, `null`
  when one covering machine has never synced cleanly; a machine whose last
  session ended more than 30 days before `from` is not listed
- [ ] Bad `day_start` (`24:00`, `4:00`, `ab:cd`) and unknown `include` values
  are 400s naming the parameter
- [ ] `bun test`, `bun run check:skills`, `bun run type-check:axi` pass

## Risks / unknowns

- **Empty pushes.** If the satellite push client only sends when files
  changed, a quiet machine's clean sync instant never advances and
  `complete_through` stalls. Item 3 checks this first; the fix is on the
  client side.
- **The 30-day coverage rule** is a heuristic for "this machine is still in
  use". A machine retired inside that window holds `complete_through` back
  until it ages out. Listing it first makes that visible; a manual retire flag
  is out of scope until it bites.
- **Payload size with blocks** over a 92-day window is a few thousand small
  objects at most; acceptable, and opt-in.

## Out of scope

- Server-side subtraction of caller-supplied busy intervals (e.g. a `busy=`
  parameter). Blocks let the consumer do it with its own meeting source.
- Per-session blocks.
- Any change to classification or to `GET /sessions/activity`.
- Alerting on stale machines; the existing coverage heartbeats already page.
