---
status: done
depends: []
specs:
  - specs/modules/kitchen.md
issues: [214]
pr: 218
---

# Plan: Expenditure skip visibility — ledger-framed guidance + `--include-skipped`

## Scope

`expenditure log`'s CLI help said the verb was "only for burns that never
reach Strava." The Strava sync deliberately skips (never retries) any
activity Strava reports with no calorie value — refusing to write a burn as
0 is correct, but it means the activity most likely to need a stated burn
(a manually-entered Strava activity — the manual-entry form has no calories
field, and without HR/power Strava computes none) is exactly the one the
old wording read as forbidding. The skip was also invisible outside server
logs, so "will this ever arrive?" had no CLI answer.

In scope:

1. Reword the guidance around the LEDGER, not the source — a Strava
   activity with no calorie value is never imported and is the owner's to
   state — in `expenditure log`'s CLI help, the discovery/`--help` summary
   line, and `specs/modules/kitchen.md` § Strava activity sync.
2. Make a permanent skip visible from the CLI: `expenditure list
   --include-skipped`, backed by a live (never persisted) read of the
   sync's current-tick skip list.

Out of scope: linking a manually-stated burn back to the Strava activity it
corresponds to (`--strava-activity-id` on `expenditure log`, issue #214
item 3) — see Follow-ups. **No DB migration** — the skip list is derived
live from the sync's in-memory state each tick, never stored; `kitchen.
expenditures` is unchanged.

## Implements

- **specs/modules/kitchen.md § Expenditure & net energy** — API line gains
  `GET /kitchen/expenditures/skipped`.
- **specs/modules/kitchen.md § Strava activity sync** — new "Skip
  visibility" subsection: what a permanent skip means (the trailing-window
  relist re-evaluates and re-skips the same activity forever, not just this
  tick), why the old CLI wording was wrong at the boundary, and the
  surfaced-live contract (`StravaSync.getSkipped()`, no new storage).

## Approach

- **`StravaSync`** (`packages/kitchen/src/services/strava-sync.ts`): track
  the current tick's skipped activities (`activity_id`, `label`,
  `occurred_at`) in a private in-memory array, rebuilt fresh on every
  successful `run()` — never accumulated, so an activity that ages out of
  the trailing 7-day window (or that finally carries a calorie value)
  simply stops appearing next tick. A failed tick (token-refresh error)
  leaves the previous list in place rather than clearing it. `getSkipped()`
  returns a shallow-copy snapshot.
- **`routes/expenditures.ts`**: new optional `stravaSync: { getSkipped():
  StravaSkippedActivity[] }` dependency + `GET /kitchen/expenditures/
  skipped` → `{ skipped, count, tz }`, rendering the same owner-local
  `day`/`occurred_local` fields as every other timestamped row. An absent
  `stravaSync` (Strava unconfigured, or a test) reports an empty list, not
  an error — same "absent ⇒ off" doctrine as the sync's own config gate.
- **`index.ts`**: a small mutable holder (`stravaSyncHolder`) lets the
  expenditure routes — registered before the Strava block, which only
  constructs a `StravaSync` when all three credentials are present — read
  whichever instance ends up existing, without reordering the plugin body
  around the credential gate.
- **`axi/commands/expenditures.ts`**: `expenditure list --include-skipped`
  calls the new endpoint alongside the normal list and renders a second
  `skipped_strava_activities` TOON block (`activity_id`/`day`/`occurred`/
  `label` — deliberately no `ulid`/`kcal`, since it is never a stored row)
  plus a one-line "state it yourself" hint when non-empty. Mirrors the
  `entries questions` / `renderHelp` pattern already used for surfacing
  unreviewed entry notes as actionable questions.
- **Guidance rewording**, kept in lockstep across three generated/verified
  sites: `EXPENDITURE_HELP` in `axi/commands/expenditures.ts`, the
  discovery summary in `axi/reference.ts`, and the derived
  `skills/assist-kitchen/SKILL.md` (regenerated via `bun run
  build:skill`/`build:cli`, verified with `bun run check:skills`).

## Validation

- [x] `strava-sync.test.ts`: `getSkipped()` starts empty; records
      id/label/start-instant for a no-calorie activity; an inserted
      (calorie-bearing) activity is never also recorded as skipped; the
      list rebuilds fresh each tick (an activity absent from the next
      list's response disappears); a failed tick (token refresh error)
      leaves the prior list unchanged.
- [x] `expenditures.test.ts` (routes): `GET /kitchen/expenditures/skipped`
      returns `{ skipped: [], count: 0 }` when `stravaSync` is absent;
      returns the live list with owner-local `day`/`occurred_local` fields
      (and `null`s for a missing start instant) when present, with no
      `ulid`/`kcal` keys on any row.
- [x] `bun run check:skills` passes — CLI bundle + `SKILL.md` regenerated
      and committed, matching the reworded help text exactly.
- [x] `bun run build` (tsc across all packages) passes clean.
- [x] `bun test`: before (stashed, clean tree) 3382 pass / 20 fail / 3402
      total across 229 files; after (this plan's changes) 3404 pass / 18
      fail / 3422 total across 229 files. Pass count went up (this plan's
      new tests, all green) and fail count did not rise — the remaining
      fails are pre-existing, unrelated to this change (hardcoded-EDT
      `date-coerce` tests failing because the sandbox runs UTC, not
      America/New_York; the extra 1 baseline fail beyond that set was a
      one-off `beforeEach`/`afterEach` timeout, not reproduced on rerun).
- [x] The reworded guidance appears in `expenditure log`'s CLI help, the
      `--help`/discovery summary line, and `specs/modules/kitchen.md`
      § Strava activity sync, and states plainly that a no-calorie Strava
      activity is never imported and is the owner's to log.

## Risks / unknowns

- The in-memory skip list resets on every server restart until the next
  tick runs. Mitigated: the Strava sync task already registers with
  `runOnStartup: true`, so it repopulates within the same boot sequence,
  not after a 30-minute wait.
- The skip list has no cross-reference to a manually-logged replacement
  burn — an activity the owner already hand-logged keeps appearing under
  `--include-skipped` until it ages out of the 7-day window (it is
  visibility, not dedup). The real fix is the out-of-scope
  `--strava-activity-id` linkage below.

## Notes

- Chose `expenditure list --include-skipped` over a dedicated `expenditure
  questions` subcommand (the issue's other suggested shape). A "questions"
  subcommand implies a per-item resolution/reviewed flow (the pattern
  `inventory questions`/`entries questions` both have, backed by a stored
  `needs_info`/`notes_reviewed` flag); a skipped Strava activity has no
  such row to mark reviewed — it resolves simply by the owner calling
  `expenditure log` for it, an already-existing verb. Reusing `list` also
  needed no new subcommand, no new lifecycle, and no new stored state —
  the smallest surfacing that is still honest about what the sync is
  doing.
- The skip list is intentionally NOT keyed to a database table. Storing it
  would need a migration (out of bounds for this plan) and would raise a
  real question — how long does a skip stay "current" once stored? — that
  the live, tick-rebuilt in-memory list sidesteps entirely: it always
  reflects exactly what the sync's own trailing-window logic currently
  considers in play.

## Follow-ups

- Issue #214 item 3 (deliberately out of scope for this plan): an optional
  `--strava-activity-id` flag on `expenditure log` to link a manually
  stated burn to the Strava activity it corresponds to, so a future feed
  change (e.g. a Strava calorie backfill) has something to dedupe against
  instead of inserting a second row for the same activity.
