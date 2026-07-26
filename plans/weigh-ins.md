---
status: done
depends: []
specs:
  - specs/modules/kitchen.md
issues: [121]
pr: 147
---

# Plan: Weigh-ins — server side (phase 3)

## Scope

The kitchen module's weigh-in surface per `specs/modules/kitchen.md`
§ Weigh-ins: the `kitchen.weigh_ins` table, idempotent `POST /kitchen/weigh-ins`
(ulid or server-seeded `hc_uuid`, explicit-offset `occurred_at` required),
raw list read, the derived `GET /kitchen/weight?days=N` (daily median
collapse + 7-day rolling trend, read-time only), DELETE, and the CLI verbs
(`weigh-ins list|log`, `weight trend`). Evidence base: the two 2026-07-26
probe dumps (Hari plans/health-connect-probe.md + health-probe-v2.md).

Out of scope: the app-side Health Connect reader (hari-capture, its own
spec/plan), any automatic TDEE/targets tuning (spec forbids it), summary/net
changes.

## Implements

- **§ Weigh-ins** — data shape, seeded idempotency
  (`healthconnect:<record-uuid>`, same convention as `strava:<id>`),
  zone-explicit `occurred_at` (400 on naive timestamps), read-time
  derivations, CLI.

## Approach

- Migration: `kitchen.weigh_ins` (ulid PK, occurred_at timestamptz,
  weight_kg numeric, body_fat_pct numeric null, source text, created_at).
- Routes follow the expenditure-routes pattern (register + store interface +
  Pg/memory stores). POST accepts exactly one of `ulid`/`hc_uuid`; seeding
  reuses `ulidFromSeed`.
- Daily bucketing derives each reading's local date from its OWN stored
  offset (no server zone assumption); median per day; 7-day rolling mean
  over existing daily values only.
- CLI + bundle rebuild via `bun run build:skills`; `check:skills` clean.
- Tests: idempotent replay (both ulid and hc_uuid paths), naive-timestamp
  400, median collapse with a multi-reading morning (synthetic), trend
  window math, offset-aware day bucketing across a zone boundary.

## Implementation decisions

- **`tz_offset_minutes` column.** Postgres `timestamptz` normalizes to UTC
  and discards the poster's offset, so "bucket by the reading's own offset"
  needs the offset persisted: an `INTEGER NOT NULL` (minutes east of UTC)
  captured verbatim from the POSTed `occurred_at`'s explicit offset at
  ingest. Local day = stored UTC instant + offset, computed read-time in
  `localDateOf()` — no server-zone input anywhere in the bucketing.
- **Naive `--at` in the CLI gets the machine's local offset attached**
  (`ensureExplicitOffset`, DST-correct for the dated day). The server-side
  400 is about never *guessing* a zone; the CLI isn't guessing — it knows
  its machine's clock, same trust basis as the bare-date → local-noon
  coercion it already applies.
- **`source` is free text** (writer package id or `manual`), not an enum —
  the spec names it "writer package id, e.g. the scale app's", which is an
  open set, unlike the expenditure sources.
- **Weigh-in store list cap is 2000** (vs the expenditure store's 500):
  `GET /kitchen/weight` reads a whole window of raw rows, and a 366-day
  window of several-readings-a-day mornings has to fit in one read.
- **Trend window is calendar-based**: each point averages daily values whose
  date falls in the 7 calendar days ending on that day — so a gap wider
  than the window genuinely drops out (tested), rather than "last 7 array
  elements" silently spanning months.
- Derived values round to 2 decimals to keep float noise out of medians of
  even counts and rolling means.

## Validation

- [x] Same `hc_uuid` posted twice → one row, 200 replay with the stored row.
      *`weigh-ins.test.ts` "seeds the ulid from hc_uuid server-side"; also
      covers the ulid path and both-or-neither → 400.*
- [x] `occurred_at` without an offset → 400; with offset → bucketed to the
      offset's local day in `GET /kitchen/weight`.
      *Naive timestamp AND bare date 400 with "explicit UTC offset" message;
      a 23:30 −04:00 reading whose UTC instant crosses midnight buckets to
      its own local day ("buckets each reading by ITS OWN stored offset").*
- [x] Multi-reading day collapses to the median in `daily[]`; raw rows all
      remain in `GET /kitchen/weigh-ins`.
      *Three-reading morning → median 81.5, count 3, raw count still 3;
      even-count median = mean of middle two (80.8).*
- [x] `trend[]` is a 7-day rolling mean over existing daily values (no
      interpolation).
      *A reading 8 days outside the window never bleeds into later points;
      gap days contribute nothing (80/81/82 progression test).*
- [x] CLI verbs render; bundle + SKILL.md regenerated; check:skills passes.
      *`weigh-ins --help` / `weight --help` render from the rebuilt bundle;
      `bun run check:skills` clean; full suite 321 pass / 0 fail; package
      tsc + `type-check:axi` clean.*
- [x] No code path adjusts KITCHEN_TDEE_BASE or targets from weigh-in data.
      *Weigh-in routes take only `{ store }` — no config, no writes outside
      `kitchen.weigh_ins`; `tdeeBase`/`dailyTargets` remain read-only pass-
      throughs in the expenditure summary.*

## Risks / unknowns

- Median vs last-reading for the daily value is a judgment call the spec
  makes deliberately (repeats spread ~0.7 kg); if lived experience disagrees,
  amend the spec first.

## Notes

- Merged as PR #147; deployed 2026-07-26 (migration 013 applied on boot).
  Live checks: `GET /kitchen/weight` returns the empty derivation shape;
  a zone-naive POST is rejected with the spec's clear 400 message.
- `tz_offset_minutes` column preserves each reading's own offset across
  timestamptz UTC normalization — the day bucketing input.
- `source` is free text (writer package ids are an open set), unlike the
  expenditure source enum.

## Follow-ups

- Owner-facing surfaces for the trend (daily briefing line, app display,
  plan-session context) deliberately deferred until real data accumulates
  and the TDEE-tuning conversation happens — tracked by the coordination
  plan in Hari (plans/weigh-ins-sync.md).
