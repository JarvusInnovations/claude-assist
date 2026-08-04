---
status: in-progress
depends: [kitchen-owner-tz, logged-at-noon-default, kitchen-module]
specs:
  - specs/modules/kitchen.md
issues: [184]
pr:
---

# Plan: Inventory dates bucket by the owner timezone

## Scope

Route every **server-derived inventory date** through the owner-timezone
bucketing the entries side already uses, so an inventory event and the journal
entry for the same act can never name different days. Implements the
"Inventory dates are owner-local calendar days" rule added to
`specs/modules/kitchen.md` § Timezone & local-day bucketing.

The defect (claude-assist#184): `kitchen-owner-tz` made entries, expenditures,
and weigh-ins bucket by `KITCHEN_OWNER_TZ`, but the inventory pipeline kept its
own `parseDate` helper that stamped the **UTC** calendar day. In a UTC−04:00
instance every event after 20:00 local has already crossed into the next UTC
day, so a meal logged and its own depletion — fired seconds apart — landed on
different dates. Confirmed on `closed_at`; the whole date surface was suspect.

**In scope:** all `DATE`-typed inventory fields and the read-time counts derived
from "today"; the `timestamptz` a consuming inventory verb writes; the CLI flags
that feed them.

**Out of scope:**

- Terminal items still cannot be annotated after the fact (#179) — the reason a
  wrong date was permanent, but a separate defect with its own fix. Untouched.
- Any change to what the entries/expenditure/weigh-in side does. That half is
  the reference implementation and is byte-for-byte unchanged.
- Backfilling dates already written wrong. Historical rows keep whatever they
  were stamped with; correcting them is an owner action, not a migration (the
  module cannot know which side of midnight a past act fell on).

## Implements

- `specs/modules/kitchen.md` § Timezone & local-day bucketing — the new
  "Inventory dates are owner-local calendar days" rule: the three-input
  resolution (absent → owner-local now, bare date → verbatim, timestamp → its
  local day), the owner-local anchor for `days_until_eat_by`/`age_days`, the
  shared zone for an inventory verb's consumption entry, and the statement of
  why the calendar-day fields deliberately do NOT take § Logged-at backdating's
  local-noon coercion.

## Approach

- **Two helpers in `zoned.ts`** (the module's existing owner-tz home, so there is
  no second implementation): `ownerLocalDate(at, zone, now)` → the owner-local
  calendar day as the UTC-midnight `Date` a `DATE` column round-trips, and
  `ownerLocalInstant(at, zone, now)` → the instant for a `timestamptz`, with a
  bare date resolving to noon *in the owner zone*.
- **Delete `parseDate`** from `services/inventory.ts` (and its `index.ts`
  re-export) rather than leaving a UTC-stamping helper exported to be reused.
  Replace every call with one private `eventDay()` choke point on the pipeline.
- **Thread the resolved `OwnerTz`** into `InventoryPipeline` via config, from the
  same `resolveOwnerTz()` call the other three route groups already receive.
  Absent ⇒ the stated UTC fallback, exposed as `pipeline.tz` and surfaced on the
  inventory list response.
- **Inject the clock** (`config.now`) so the *defaulted*-date path — the one the
  bug actually travelled — is testable against a seeded instant.
- **`toItemView` takes a zone** for its "today" anchor, so `days_until_eat_by`
  and `age_days` count from the owner's day.
- **CLI**: add `validateCalendarDate` alongside `validateDate` and point every
  inventory/receipt date flag at it. A bare date goes to the server verbatim;
  the local-noon coercion stays on the `timestamptz` flags where it belongs.

## Validation

- [x] An event fired at a local evening time that has crossed the UTC day
      boundary stamps the LOCAL day. (`inventory-owner-day.test.ts` — seeded at
      2026-08-04T01:31Z in a −04:00 instance; verified to FAIL under the old UTC
      semantics, 12 of 17 cases.)
- [x] Full enumeration covered, each asserted independently: `closed_at`
      (finish, dismiss, merge-retire, stated-weight eat, consume),
      `opened_at`, defaulted `acquired_at`, `purchased_at`, `storage_moved_at`,
      the `eat_by` anchored on each, and the dates inside toss / consumption /
      reconcile / storage-move audit notes.
- [x] `days_until_eat_by` / `age_days` count from the owner-local today.
      (Verified to fail when the view's zone is forced back to UTC.)
- [x] A consuming inventory verb's entry `logged_at` and the item's `closed_at`
      name the same day, including for a bare `--at`.
- [x] A bare `YYYY-MM-DD` is taken verbatim and survives an east and a west zone
      unchanged; a full timestamp lands on the day its wall clock reads; both
      DST transitions hold. (`zoned.test.ts`)
- [x] `KITCHEN_OWNER_TZ` unset ⇒ UTC, stated (`tz` on the list response,
      `UTC (KITCHEN_OWNER_TZ unset)`), never a silent guess.
- [x] Tests are time-proof: every instant is seeded, no trailing default window,
      no wall-clock read. (The failure mode PR #183 / 918509f fixed.)
- [x] `bun run build` green, `bun run check:skills` green,
      `bun run type-check:axi` green, full `bun run test` green.

## Risks / unknowns

- **A bare date must not be re-zoned.** Passing `YYYY-MM-DD` through an instant
  conversion re-introduces exactly the offset dependence being removed — hence
  verbatim, asserted in both hemispheres.
- **Two existing CLI assertions pinned the old coercion** on inventory `--at`.
  They encoded the defect, not the contract, and were updated with the reason in
  place. No other test changed.
- **Historical rows** keep their original (possibly wrong) dates; nothing in the
  read path retro-corrects them, and nothing should.

## Notes

- Found while auditing the CLI layer: `inventory waste --since/--until` was
  **broken**, not merely redundant. The route pins those params to
  `^\d{4}-\d{2}-\d{2}$` and compares them against bare toss dates as strings, so
  the local-noon coercion turned a valid `--since 2026-08-03` into a full
  timestamp — rejected by the route schema, and before that silently excluding
  same-day tosses. `validateCalendarDate` fixes it as a side effect of putting
  each flag on the validator its destination type calls for.
- The issue reported the inventory verbs as having "no equivalent guard" to
  `entries log --at`. They in fact had the *entries* guard, applied to
  calendar-day fields — the wrong guard rather than a missing one. The fix is a
  second validator, not an added coercion.

## Follow-ups

- **#179 (terminal items cannot be annotated)** is unaffected and unfixed. It is
  what made a wrong date permanent; with dates now correct by default, it is
  less load-bearing but still the reason a mistake cannot be repaired.
- The capture app formats inventory dates client-side, as it does for entries
  (`kitchen-owner-tz` left the same carry-forward). Aligning it to the server's
  day fields remains a client change.
