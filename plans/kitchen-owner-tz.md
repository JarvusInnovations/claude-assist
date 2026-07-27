---
status: done
depends: [kitchen-module]
specs:
  - specs/modules/kitchen.md
issues: []
pr:
---

# Plan: Module-owned timezone + local-day AXI output + per-day rollup

## Scope

Make timezone/day-bucketing the module's responsibility instead of the caller's,
so no AXI surface ever hands back a bare UTC instant that an agent must convert to
know the local day. Implements `specs/modules/kitchen.md` § Timezone & local-day
bucketing. Three pieces:

1. **`KITCHEN_OWNER_TZ` config** — one IANA zone as the source of truth for all
   day boundaries (unset ⇒ UTC fallback, stated in output).
2. **`day` field + local-time display** on entry / expenditure / weigh-in rows in
   AXI list and detail output.
3. **A per-day rollup** — `kitchen-axi days [--since]` over a day-grouped
   `/kitchen/summary`, returning per-owner-local-day panel + calories + net.

**Out of scope:** changing what the net line means (still context, not a budget);
the write-side bare-date coercion (already shipped, PR #142) — this is the read
side; any model authority over time (spec forbids it).

## Implements

- `specs/modules/kitchen.md` § Timezone & local-day bucketing — owner-tz config,
  `day` on rows, local-time display, the per-day rollup as an AXI §4 aggregate,
  and the module-wide bucketing guarantee.

## Approach

- **Config**: read `KITCHEN_OWNER_TZ` (IANA) once at startup; expose a resolver
  the server uses for every day computation (`Intl.DateTimeFormat` /
  `zonedparts` — no hardcoded offsets; DST-correct per date). Unset ⇒ UTC + a
  `tz: UTC (KITCHEN_OWNER_TZ unset)` note on affected output.
- **`day` on rows**: compute the owner-tz calendar date server-side and include
  it on entry / expenditure / weigh-in read models; the AXI formatter shows
  `day` and renders the instant in the owner zone. Retire the CLI's
  `startOfTodayIso()` / caller-window hack in `home.ts` — the server derives
  "today" from the owner zone.
- **Day-grouped summary + `days` command**: extend `GET /kitchen/summary` with a
  day-grouped mode (or add an endpoint) that returns one row per owner-local day
  over the window — eight-field panel, calories, net (when TDEE base set). Add
  `kitchen-axi days [--since <n|date>]` that renders it as TOON. Wire contextual
  disclosure (home view suggests `days` for the trend).
- **Docs**: SKILL.md + reference — a `day` field is authoritative for bucketing;
  never derive a day from a timestamp; use `days` for multi-day totals. Rebuild
  the bundle; `check:skills` passes.

## Validation

- [x] With `KITCHEN_OWNER_TZ=America/New_York`, an entry logged at `T00:47Z`
      (previous-evening local) reports `day` = the local date, not the UTC date.
      (`zoned.test.ts`, `summary-days.test.ts`, `entry-day.test.ts`)
- [x] `entries list` / `expenditure list` rows carry `day` (owner-local) and show
      local-time instants; no bare `Z` UTC string is the only time signal.
      (`entry-day.test.ts`, `summary-days.test.ts` — rows expose `day` +
      `logged_local`/`occurred_local` with an explicit offset; raw `logged_at`
      kept for ordering.)
- [x] `kitchen-axi days --since 7d` returns one row per local day with correct
      panel + calories + net, matching hand-checked entries — and a week that
      previously mis-bucketed under UTC now buckets correctly.
      (`summary-days.test.ts` per-day + mis-bucket cases; `days.test.ts` end-to-end
      CLI render.)
- [x] Home "today" totals derive from the owner zone server-side (no caller
      day-window; `startOfTodayIso()` retired), and match `days` for the current
      day (both read the same day-grouped rollup's `today` row). (`days.test.ts`)
- [x] `KITCHEN_OWNER_TZ` unset ⇒ UTC fallback with an explicit stated note
      (`tz: UTC (KITCHEN_OWNER_TZ unset)`), never a silent guess.
      (`zoned.test.ts`, `summary-days.test.ts`)
- [x] DST boundaries (spring-forward, fall-back) bucket correctly.
      (`zoned.test.ts` offset assertions, `summary-days.test.ts` day rollups.)
- [x] `check:skills` passes; SKILL/reference state `day`-is-authoritative and
      point to `days` for multi-day totals.

## Risks / unknowns

- **Migration of the net/summary window contract**: `/kitchen/summary` currently
  takes `since`/`until` UTC. Day-grouped mode must not break the existing
  windowed callers (home view). Keep the windowed mode; add grouping.
- **`day` on historical rows**: computed on read from the stored UTC instant +
  owner zone — no backfill needed, but verify old rows render a correct `day`.
- **Client displays** (capture app) may still show their own local formatting;
  this plan owns the *server/CLI* surface. Note any client follow-up at closeout.

## Notes

- Shipped `packages/kitchen/src/zoned.ts`: `resolveOwnerTz` (Intl-validated,
  UTC fallback stated, invalid zone fails boot loudly) + `localDay` /
  `localDisplay` / `offsetMinutes`, all per-instant `Intl`-based so DST is
  correct for the specific date. Threaded env.ts → core/plugin → server →
  kitchen route configs.
- Every entry / expenditure / weigh-in row now stamps `day` (owner-tz, the
  authoritative bucketing key) + a local-offset display instant; AXI schemas
  show `day` in place of the UTC-sliced date. Retired `home.ts`
  `startOfTodayIso()` — home reads the server-derived `today`.
- `GET /kitchen/summary?group=day` (existing windowed mode byte-identical) +
  new `kitchen-axi days [--since <n|date>]` render one row per owner-local day
  (panel + calories + net when TDEE base set). Home suggests `days`.
- Verified independently before merge: `bun test packages/kitchen/src` →
  363 pass / 0 fail (+24, incl. DST spring/fall, month boundary, per-day
  rollup, unset-fallback); `bun run build` green; CI on #152 green; scrub clean.
  `localDay`/day-stamp/wiring inspected by hand.
- **Deploy requires setting `KITCHEN_OWNER_TZ`** in `apps/server/.env` (instance
  config, same as `KITCHEN_TDEE_BASE`) — unset ⇒ stated UTC fallback, which
  does not fix the bucketing. Set at deploy time.

## Follow-ups

- **Deferred to client:** the capture app still formats its own local display
  client-side; this plan owns the server/CLI surface only. Align the app to the
  server `day`/`local` fields in a client change.
