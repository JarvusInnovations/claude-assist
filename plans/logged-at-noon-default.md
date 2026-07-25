---
status: done
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

- [x] `entries log --at 2026-07-24` (bare date) stores `logged_at` at local noon
      that day; the entry buckets on 2026-07-24 in a US-Eastern rollup, not the
      23rd. (date-coerce.test.ts, TZ pinned to America/New_York: coerced instant
      is 2026-07-24T16:00:00Z = noon EDT, getDate()===24 vs the naive UTC-midnight
      parse which reads the 23rd.)
- [x] `entries log --at 2026-07-24T15:00:00-04:00` (full timestamp) is stored
      verbatim — no coercion applied. (helper + both entries builders + ingest.)
- [x] Same coercion verified for `entries patch --at` (buildPatchBody +
      pipeline.patch server path) and `expenditure log --at` (validateDate — the
      exact choke point that command calls; also the shared server parseIso).
- [x] A bare date near a month/DST boundary still lands on the intended local
      day. (date-coerce.test.ts: winter EST -05:00 vs summer EDT -04:00, DST
      spring-forward 2026-03-08 and fall-back 2026-11-01, month boundary
      2026-07-01 — all at noon, correct day.)
- [x] `check:skills` passes after the SKILL/help update; `--at` help text names
      the local-time preference + noon backstop (entries + expenditure help,
      reference.ts summaries, SKILL.md narrative bullet).
- [x] Existing full-timestamp and default-to-now behaviors unchanged
      (regression: full suite 294 pass; two existing --at passthrough assertions
      updated to the new local-noon semantics; normalizeNewEntry default-to-now
      test).

## Risks / unknowns

- **Where the coercion belongs** (CLI-only vs. also server-side) depends on
  whether the API can receive a bare-date `logged_at`. Prefer the lowest shared
  choke point; if both CLI and API can take bare dates, coerce in both.
- **Timezone source**: the machine's local offset at the target date (respect DST
  for the *dated* day, not just today). Use the runtime's zoned construction, not
  a fixed offset.

## Implementation decision — choke points (in-progress)

Coerced at **both the CLI and the API**, via one shared helper
`coerceBareDateToLocalNoon` in `packages/kitchen/src/date-coerce.ts` (imported by
every site so there is no drift). A bare date **can** reach the API directly:
`POST /entries`'s `validateEntryInput` only checks `typeof logged_at === 'string'`
and the `PATCH` / expenditure JSON schemas pin the type to `{type: 'string'}`
with no date-format constraint — so a non-CLI caller (or a future client) can send
`logged_at: "2026-07-24"` and hit `new Date("YYYY-MM-DD")` = UTC midnight. The
guarantee therefore has to hold server-side too, not only on the agent path.

Sites wired:

- **CLI** — `validateDate` in `axi/args.ts` (the one helper all three `--at`
  flags call: `entries log`, `entries patch`, `expenditure log`).
- **API ingest** — `normalizeNewEntry` in `store.ts` (`POST /entries`).
- **API patch** — `KitchenPipeline.validateLoggedAt` in `services/pipeline.ts`
  (`PATCH /entries/:ulid`), before the parse + clock-relative bounds check.
- **API expenditure** — `parseIso` in `routes/expenditures.ts`
  (`POST /kitchen/expenditures` `occurred_at`).

The helper constructs `new Date(year, month-1, day, 12, 0, 0)` (local-zoned) and
serializes `<date>T12:00:00±HH:MM` using that Date's own `getTimezoneOffset()`, so
the offset reflects DST **for the dated day**, not today. A value carrying any
time-of-day is returned untouched.

## Notes

- Shipped `coerceBareDateToLocalNoon` (`packages/kitchen/src/date-coerce.ts`):
  a bare `YYYY-MM-DD` rebuilds as noon on that day in the machine's local zone,
  serialized with the offset in effect **on the dated day** (DST-aware per date),
  and any value with a time-of-day passes through unchanged.
- **Coerced at four choke points** because bare dates can reach the API directly
  (the `POST`/`PATCH`/expenditure validators accept any string, so a non-CLI
  caller could send a bare date): CLI `validateDate` (`axi/args.ts`), entry
  ingest (`store.ts`), `logged_at` PATCH (`services/pipeline.ts`), and
  expenditure `occurred_at` (`routes/expenditures.ts`). One shared helper.
- Docs: `--at` help + `reference.ts` summaries + a SKILL.md narrative bullet all
  now say "prefer a full local timestamp; a bare date backstops to local noon."
  Bundle + SKILL regenerated; `check:skills` passes.
- Verified independently before merge: `bun test packages/kitchen/src` →
  294 pass / 0 fail (new `date-coerce.test.ts` TZ-pinned to America/New_York,
  covering EST/EDT, both DST transitions, month boundary, all CLI sites +
  server); CI on #142 green (Build & Test, Docker Build); full-diff scrub clean.

## Follow-ups

- **None.** Companion agent-practice (always supply an explicit local time on a
  backdated log) is captured on the Hari side, not a code follow-up here.
