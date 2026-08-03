---
status: done
depends: []
specs: []
issues: []
pr: null
---

# Plan: Fix the wall-clock time bomb in summary-days.test.ts

## Why

`packages/kitchen/src/routes/summary-days.test.ts` had two tests that seeded an
entry at the hardcoded instant `2026-07-26T00:47:00Z` and then queried
`GET /kitchen/summary?group=day` with no `since`/`until`. That route's day-grouped
mode defaults to a trailing 7-owner-local-day window from `new Date()`
(`packages/kitchen/src/routes/expenditures.ts`, `summaryByDay`, around line
244-245). Once the hardcoded seed date rolled more than 7 days behind the real
clock, the query returned zero days and the assertions on `body.days[0]` failed —
not a flake, a certainty: it fails every day from the date it rolls out of the
window, forever, on every branch, independent of any PR's own changes.

Confirmed pre-existing and unrelated to any open work: reproduces on unmodified
`origin/main`.

## Scope

In scope: the two affected tests in `summary-days.test.ts`. Out of scope: the
route's default-window behavior itself, which is correct and unchanged — the
test was wrong, not the route. Also out of scope: no other kitchen test file
has this pattern (see Validation) — this is a single-file fix, not a sweep.

## Approach

Both tests already had a same-file precedent for the right style: neighboring
tests (`per-day panel + calories + net over a window`, `a week that mis-buckets
under UTC…`, `DST spring-forward and fall-back…`) all pass an explicit
`since`/`until` around their seeded dates instead of relying on the route's
default window. Applied the same style to the two broken tests: added
`&since=2026-07-25T00:00:00Z&until=2026-07-27T00:00:00Z` to each request,
bracketing the seeded `2026-07-26T00:47:00Z` instant with a fixed window that
has no relationship to the wall clock. The tests are about owner-local-day
bucketing (does `T00:47Z` land on the UTC date or the NY-local date, and does
an unset `KITCHEN_OWNER_TZ` fall back to UTC and say so) — nothing about them
depends on the seeded data being recent, so a fixed window is strictly correct,
not a workaround.

Considered and rejected: reseeding relative to "now" (e.g. "yesterday at
00:47Z"). Rejected because these two tests specifically exercise date
arithmetic across a local-day boundary, and a relative date computed at test-run
time can itself land wrong across a DST transition or a month/year edge — which
would trade one clock dependency for a subtler one. A fixed instant + fixed
window has no such edge case.

Did not touch `packages/kitchen/src/routes/expenditures.ts` — the route's
trailing-window default is the documented, correct behavior; only the test was
wrong.

## Validation

- [x] `bun test packages/kitchen/src/routes/summary-days.test.ts` — 10 pass, 0
      fail (both previously-failing tests now pass)
- [x] Audited every other kitchen test file for the same shape (hardcoded date +
      no explicit since/until against a route with a real rolling-`now()`
      default). Only two routes in the whole package default a query window off
      `new Date()`: `summaryByDay` (`GET /kitchen/summary?group=day`) and
      `GET /kitchen/weight` (`weigh-ins.ts`, defaults to a trailing 30 days). No
      other test hits either with a hardcoded date and an assertion that depends
      on the window's contents — `weigh-ins.test.ts` seeds every date relative to
      `Date.now()` at test-run time via a `dayUtc(n)` helper, so it inherently
      tracks the clock. No further time bombs found.
- [x] `bun install && bun run build && bun run test` (fresh worktree, matching
      CI's own sequence per `ci-tests-actually-run.md`) — exit 0, all packages
      `0 fail`, kitchen package 764 pass
- [x] `bun run type-check:axi` — clean
- [x] `bun run check:skills` — clean
- [x] Time-proof by construction: the fix replaces "whatever the last 7 days are
      when this runs" with a window whose boundaries (`2026-07-25T00:00:00Z` /
      `2026-07-27T00:00:00Z`) are fixed relative to the fixed seed instant, not
      to wall-clock time. The assertions will read identically in six months,
      six years, or on a machine with its clock set wrong.

## Risks / unknowns

None — this is a pure test-correctness fix with no route/behavior change.

## Notes

- A fresh `git worktree add` has neither `node_modules` nor any package's
  `dist/` (gitignored); `bun run test` alone fails several packages with
  `Cannot find module '@jarvus/claude-assist-*'` until `bun install && bun run
  build` runs first. Same gotcha `ci-tests-actually-run.md` already documents
  for CI's own sequence — recorded here again because it cost real time
  diagnosing what looked like an unrelated regression before `dist/` turned out
  to just be missing.
- `mealbank.test.ts` (part of the kitchen package's 764) is known-occasionally-
  flaky on a cold first run (shells out to the `gitsheets` CLI under a 5s hook
  budget). It passed clean on the first run here; no re-run was needed.

## Follow-ups

None.
