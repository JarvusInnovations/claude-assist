---
status: done
depends: []
specs:
  - specs/modules/kitchen.md
issues: [121]
pr: 150
---

# Plan: Strava activity sync — scheduled exercise auto-feed (phase 2)

## Scope

The unattended server-side Strava pull per `specs/modules/kitchen.md`
§ Strava activity sync: OAuth token custody with rotation persistence
(`kitchen.strava_oauth`, env as first-boot seed only), a scheduler task
(default every 30 min) that lists the trailing 7 days and inserts
expenditure rows for unseen activities via the locked seed
`ulidFromSeed(0, "strava:<activity_id>")` — list→detail because calories
exist only on the detail endpoint. No cursor: idempotent replays are the
resume semantics. Ends the manual agent-driven backfill ritual.

Out of scope: any deletion/merging of overlapping manual rows (warn-only by
spec), activity metadata beyond the burn (anti-scope), webhook push
ingestion (polling is plenty at personal volume; revisit only if the
cadence ever matters).

## Implements

- **§ Strava activity sync** — config gate (all-three-or-off), token
  rotation custody, pull contract, absent-calories skip, cross-source
  warn-only rule.

## Approach

- Migration: `kitchen.strava_oauth` single-row table (refresh_token,
  access_token, expires_at, updated_at).
- A `StravaClient` (fetch-based, no SDK dependency) with token refresh +
  rotation persistence; direct Strava v3 API (`/athlete/activities`,
  `/activities/:id`) — deliberately NOT the local Strava MCP (that path is
  interactively authenticated session tooling; the module needs unattended
  server-side auth it owns).
- Scheduler task registered like `kitchen:estimate`, gated on config
  presence; each tick: refresh-if-expiring, list window, filter unseen by
  seeded ulid, detail + insert via the existing expenditure store.
- Overlap warning: after insert, log any manual/garmin row whose
  [occurred_at, occurred_at + duration] intersects the new row's span.
- Tests (synthetic fixtures, PUBLIC repo — no real tokens/activities):
  token rotation persisted after refresh; env ignored once row exists;
  all-three-or-off gating; unseen-only detail fetching; seed replay
  (backfilled ulid → no duplicate); absent-calories skip; overlap warning
  emission.
- Deploy note (instance side, not repo): owner seeds the three env values
  from their Strava API application; first tick backfills/replays the
  trailing week.

## Validation

- [x] With config absent, no task registers and nothing Strava-related runs.
      — `isStravaSyncConfigured` gates registration in
      `packages/kitchen/src/index.ts` (any-missing/blank ⇒ false; covered by
      the "all-three-or-off" tests in `strava-sync.test.ts`).
- [x] First tick against a fixture list replays the seeded backfill ulids
      (0 duplicates) and inserts only unseen activities.
      — test "already-seen seeded ulids are replayed: no duplicate row, NO
      detail call": exactly one detail fetch (for the unseen activity), store
      ends with 2 rows, not 3. The unseen filter runs through the new
      `ExpenditureStore.existingUlids()` bulk lookup.
- [x] Refresh-token rotation: the rotated token is persisted and used on
      the next refresh; the env seed is ignored once the row exists.
      — tests "the rotated refresh token is what the NEXT refresh uses"
      (second token call presents `synthetic-refresh-1`) and "once a row
      exists the env seed is ignored" (refresh body carries the stored token,
      never the env seed).
- [x] An activity without calories is skipped with a log line, never
      written as 0. — tests for both absent and `calories: 0`
      (`skipped_no_calories: 1`, zero rows written, info log emitted).
- [x] A manual row overlapping a synced activity produces a warning log and
      remains untouched. — test "warns about an overlapping manual row and
      leaves it untouched" (warn emitted; manual row byte-identical after the
      tick); non-overlap counter-test emits nothing.
- [x] Kitchen suite + type checks green; no bundle/skill changes needed
      (no CLI surface). — `bun test src` in packages/kitchen: 339 pass /
      0 fail; repo-wide `bun run build` (tsc all packages) + `bun run
      type-check:axi` clean; `bun run check:skills` reports all bundles up
      to date (nothing rebuilt).

## Risks / unknowns

- Strava app-level rate limits are generous for one athlete, but a bug that
  detail-fetches the whole window every tick would burn them — the
  unseen-only filter is load-bearing; test it directly.
- Token revocation (owner de-authorizes the app) leaves a dead stored row;
  the spec's recovery is manual row deletion + env re-seed — documented in
  the plan, acceptable for an owner-operated instance.

## Notes

Implementation decisions (2026-07-26, PR #150):

- **Token custody lives in `StravaClient`** (`services/strava-client.ts`),
  with storage behind a `StravaOAuthStore` interface in `store.ts`
  (`PgStravaOAuthStore` + `MemoryStravaOAuthStore`), mirroring the existing
  store split. The rotated refresh token is persisted **before** the new
  access token is used; a failed refresh throws typed `StravaRefreshError`,
  which `StravaSync.tick()` catches to skip the tick with a warning — the
  stored row is never deleted on failure.
- **Fetch is an injected `FetchLike`** on the client (default
  `globalThis.fetch`) — the test seam sits at the client boundary, so tests
  drive the real token/pull logic against synthetic responses.
- **Unseen filter**: added `existingUlids(ulids)` to `ExpenditureStore`
  (Pg: single `WHERE ulid IN` query) rather than reusing `list()` — the
  cheap bulk lookup is what keeps steady-state usage at one list call/tick.
- **Cadence → cron**: `KITCHEN_STRAVA_SYNC_MINUTES` stays a string in the
  env schema so the kitchen plugin validates it boot-loud
  (`StravaSyncConfigError`, KITCHEN_DAILY_TARGETS precedent). It parses even
  when the feature is off (malformed config always fails boot). Cron
  rendering accepts 1–59 minutes (`*/N`) or whole hours (`0 */H`); anything
  cron can't represent (e.g. 90) is a boot error rather than a silently
  drifted cadence.
- **DISABLE_SYNCS is respected**: the server folds it into
  `disableStravaSync`, same convention as every other scheduled sync — a
  dev boot with production env never hits Strava.
- **Overlap warning scope**: warns on any overlapping row whose source is
  not `strava` (i.e. manual/garmin/health_connect), inclusive span
  intersection; candidates are over-fetched from a ±24 h window and
  intersected in code (spans aren't stored as ranges).
- **Skipped-row guard beyond spec**: a detail with no usable `start_date`
  is also skipped with a warning (never a guessed timestamp) — same
  stated-numbers doctrine, no spec change needed.
- Label mapping: activity name trimmed, falling back `sport_type` → `type`
  → `"Activity"`; `avg_hr`/`duration_min` rounded, absent HR stays null.

## Follow-ups

_(at closeout)_
