---
status: planned
depends: []
specs:
  - specs/modules/kitchen.md
issues: [121]
pr:
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

- [ ] With config absent, no task registers and nothing Strava-related runs.
- [ ] First tick against a fixture list replays the seeded backfill ulids
      (0 duplicates) and inserts only unseen activities.
- [ ] Refresh-token rotation: the rotated token is persisted and used on
      the next refresh; the env seed is ignored once the row exists.
- [ ] An activity without calories is skipped with a log line, never
      written as 0.
- [ ] A manual row overlapping a synced activity produces a warning log and
      remains untouched.
- [ ] Kitchen suite + type checks green; no bundle/skill changes needed
      (no CLI surface).

## Risks / unknowns

- Strava app-level rate limits are generous for one athlete, but a bug that
  detail-fetches the whole window every tick would burn them — the
  unseen-only filter is load-bearing; test it directly.
- Token revocation (owner de-authorizes the app) leaves a dead stored row;
  the spec's recovery is manual row deletion + env re-seed — documented in
  the plan, acceptable for an owner-operated instance.

## Notes

_(at closeout)_

## Follow-ups

_(at closeout)_
