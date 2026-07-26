---
status: planned
depends: []
specs:
  - specs/modules/kitchen.md
issues: []
pr:
---

# Plan: Daily targets — owner-set reference lines

## Scope

Give the per-nutrient daily reference lines (sat-fat cap, fiber floor, sodium
cap, sugar cap, calorie band) a single server-side home and serve them with the
daily rollup, per `specs/modules/kitchen.md` § Daily targets. Today the lines
live only in the diet doctrine and as a hardcoded copy inside the capture app's
day-header coloring — two homes, no API surface, nothing a budget view can read.

In scope: `KITCHEN_DAILY_TARGETS` config parse + boot-loud validation, the
`targets` block on `GET /kitchen/summary` (omitted when unconfigured), the CLI
day-summary rendering (`logged / target` + remaining per configured line), and
tests. Out of scope: any client UI (the capture app's day budget sheet is
specced in hari-capture `specs/screens/journal.md` and planned in Hari
`plans/daily-macro-budgets.md`), and any auto-tuning of the lines.

## Implements

- **§ Daily targets** — config shape (field → exactly one of `{"max": N}` /
  `{"min": N}`), loud-fail validation, verbatim `targets` exposure on the daily
  rollup, absent-config ⇒ omitted-block, direction semantics riding the wire.
- **§ Expenditure & net energy (framing rule)** — the `calories` target is
  static and intake-managed; nothing here computes or serves a burn-adjusted
  remaining.

## Approach

- Parse `KITCHEN_DAILY_TARGETS` once at module init next to `KITCHEN_TDEE_BASE`;
  reject unknown fields, dual bounds, non-positive values with a thrown config
  error (boot failure, not a warning).
- Thread the parsed value into the summary handler's response alongside
  `net_kcal`; no schema/migration work (config, not data).
- `kitchen-axi` summary output: one line per configured target with remaining;
  direction-aware wording (`left` for caps, `to go` / `met` for floors).
- Proposed initial instance values (owner confirms at deploy, from
  diet-protocol doctrine): `sat_fat_g max 13`, `sugar_g max 36`,
  `sodium_mg max 2300`, `fiber_g min 30`, `calories max 1800` (midpoint of the
  1,550–1,950 band). `protein_g`/`fat_g`/`carbs_g` unconfigured in v1.

## Validation

- [ ] Summary response carries `targets` verbatim when configured; the key is
      entirely absent when the env var is unset.
- [ ] Malformed config (unknown field / `{"min","max"}` together / `-5`) fails
      server boot with a clear message.
- [ ] CLI day summary renders each configured line with direction-correct
      remaining; unconfigured fields render unchanged.
- [ ] No code path combines targets with expenditure/net (grep-level check +
      test asserting `targets.calories` is the raw config regardless of burns).
- [ ] Existing summary consumers (app day header, home dashboard) unaffected
      when config absent.

## Risks / unknowns

- The capture app currently hardcodes the same lines for day-header coloring;
  until the app-side plan drains, the two copies coexist — acceptable because
  the values are identical and the app treats server targets as the override
  when present (specced in journal.md).

## Notes

_(at closeout)_

## Follow-ups

_(at closeout)_
