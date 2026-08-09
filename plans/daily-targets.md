---
status: done
depends: []
specs:
  - specs/modules/kitchen.md
issues: []
pr: 145
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
specced and planned on the instance side (a capture app screen plus the
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

- [x] Summary response carries `targets` verbatim when configured; the key is
      entirely absent when the env var is unset. (expenditures.test.ts: verbatim
      block asserted with `toEqual`; `'targets' in json === false` when
      unconfigured — absent, not null/`{}`.)
- [x] Malformed config (unknown field / `{"min","max"}` together / `-5`) fails
      server boot with a clear message. (daily-targets.test.ts: every malformed
      shape throws `DailyTargetsConfigError` with a named-field message;
      `parseDailyTargets` runs at kitchen plugin init, so the throw aborts
      `fastify.register` → startup fails.)
- [x] CLI day summary renders each configured line with direction-correct
      remaining; unconfigured fields render unchanged. (axi.test.ts `targetLine`
      cases: max under/at/over, min under/met; home.ts `vsTarget` falls back to
      the plain total when a field has no bound.)
- [x] No code path combines targets with expenditure/net (grep-level check +
      test asserting `targets.calories` is the raw config regardless of burns).
      (Route test logs a 400-kcal burn and asserts the targets block is
      untouched raw config; the server spread is verbatim and the CLI remaining
      uses intake totals only.)
- [x] Existing summary consumers (app day header, home dashboard) unaffected
      when config absent. (Unconfigured ⇒ the key is never present, response
      shape unchanged; all pre-existing kitchen tests pass — 306 total.)

## Implementation decisions

- Parsing lives in the kitchen package (`src/daily-targets.ts`, exported), not
  the server: the env var is read next to `KITCHEN_TDEE_BASE` in `server.ts`
  and passed through raw; `parseDailyTargets` runs once at kitchen plugin init,
  so a malformed value throws inside `fastify.register` and fails boot.
- An explicit `{}` (zero configured lines) parses to undefined — same as unset,
  the summary never serves an empty `targets` block.
- A breached `max` renders `(N over)` in the CLI rather than a negative
  "left" — a max exceeded is a breach and says so (direction is semantic);
  `left`/`to go`/`met` wording otherwise as specced.
- `.env.example` documents the var with synthetic example values only; real
  lines are deploy-time instance config (owner sets them in the untracked
  `.env`).

## Risks / unknowns

- The capture app currently hardcodes the same lines for day-header coloring;
  until the app-side plan drains, the two copies coexist — acceptable because
  the values are identical and the app treats server targets as the override
  when present (specced in journal.md).

## Notes

- Merged as PR #145; deployed 2026-07-26 with `KITCHEN_DAILY_TARGETS` set in
  the instance env (values from the owner's diet doctrine; the repo carries
  only a synthetic `.env.example`). Live summary verified carrying the
  `targets` block verbatim alongside `net_kcal`.
- Parse lives at kitchen plugin init (`parseDailyTargets` in
  `daily-targets.ts`); an explicit `{}` parses to feature-off, same as absent.
- CLI wording gained `(N over)` for a breached cap beyond the specced
  `left`/`to go`/`met` set — a negative "left" would misread.

## Follow-ups

- None. The consuming budget-sheet UI shipped on the instance's capture app,
  tracked by that instance's own plan.
