---
status: planned
depends: [kitchen-module]
specs:
  - specs/modules/kitchen.md
issues: []
pr:
---

# Plan: Bare-date `logged_at`/`--at` coerces to local noon

## Scope

A `logged_at` / CLI `--at` supplied as a **bare calendar date** (`YYYY-MM-DD`,
no time-of-day) must coerce to **noon in the owner's local timezone**, not
midnight UTC. Midnight UTC is the previous evening across US zones, so a bare
date logged for "today" buckets onto the wrong day — observed twice in use (a
backdated party dish and a Strava run both landed a day early and needed
delete-and-relog). Implements the "Bare-date coercion → local noon" rule added
to `specs/modules/kitchen.md` § Logged-at backdating.

**Out of scope:** any model authority over `logged_at` (the spec forbids it);
changing how full timestamps are handled (only the *bare-date* case changes).

## Implements

- `specs/modules/kitchen.md` § Logged-at backdating — the bare-date → local-noon
  backstop, and the "callers SHOULD still supply a specific local time" steer.

## Approach

- **Locate the `--at` / `logged_at` coercion** in the `kitchen-axi` CLI
  (`entries log`, `entries patch`, `expenditure log` all accept `--at`) — most
  likely a shared date-parse helper. When the argument matches a bare
  `YYYY-MM-DD` (no `T`/time), build the timestamp as `<date>T12:00:00` in the
  **local** timezone (machine offset), then serialize with that offset — instead
  of letting `new Date("YYYY-MM-DD")` parse it as UTC midnight.
- A full ISO timestamp (with or without offset) passes through unchanged.
- If the API also accepts bare-date `logged_at` on `POST`/`PATCH`, apply the same
  coercion server-side so the guarantee holds regardless of caller; otherwise the
  CLI coercion suffices (the CLI is the agent path). Decide during implementation
  by checking where bare dates can enter.
- **Docs:** update the `assist-kitchen` SKILL.md guidance + the `--at` flag help
  to state that a specific local time is preferred and a bare date now defaults
  to local noon (backstop). Rebuild the skill bundle (`check:skills` gate).

## Validation

- [ ] `entries log --at 2026-07-24` (bare date) stores `logged_at` at local noon
      that day; the entry buckets on 2026-07-24 in a US-Eastern rollup, not the
      23rd.
- [ ] `entries log --at 2026-07-24T15:00:00-04:00` (full timestamp) is stored
      verbatim — no coercion applied.
- [ ] Same coercion verified for `entries patch --at` and `expenditure log --at`.
- [ ] A bare date near a month/DST boundary still lands on the intended local
      day (noon has margin for both).
- [ ] `check:skills` passes after the SKILL/help update; `--at` help text names
      the local-time preference + noon backstop.
- [ ] Existing full-timestamp and default-to-now behaviors unchanged
      (regression).

## Risks / unknowns

- **Where the coercion belongs** (CLI-only vs. also server-side) depends on
  whether the API can receive a bare-date `logged_at`. Prefer the lowest shared
  choke point; if both CLI and API can take bare dates, coerce in both.
- **Timezone source**: the machine's local offset at the target date (respect DST
  for the *dated* day, not just today). Use the runtime's zoned construction, not
  a fixed offset.

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
