---
status: planned
depends: []
specs:
  - specs/modules/kitchen.md
issues: [121]
pr:
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

## Validation

- [ ] Same `hc_uuid` posted twice → one row, 200 replay with the stored row.
- [ ] `occurred_at` without an offset → 400; with offset → bucketed to the
      offset's local day in `GET /kitchen/weight`.
- [ ] Multi-reading day collapses to the median in `daily[]`; raw rows all
      remain in `GET /kitchen/weigh-ins`.
- [ ] `trend[]` is a 7-day rolling mean over existing daily values (no
      interpolation).
- [ ] CLI verbs render; bundle + SKILL.md regenerated; check:skills passes.
- [ ] No code path adjusts KITCHEN_TDEE_BASE or targets from weigh-in data.

## Risks / unknowns

- Median vs last-reading for the daily value is a judgment call the spec
  makes deliberately (repeats spread ~0.7 kg); if lived experience disagrees,
  amend the spec first.

## Notes

_(at closeout)_

## Follow-ups

_(at closeout)_
