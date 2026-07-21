---
status: planned
depends: []
specs:
  - specs/modules/kitchen.md
issues: []
pr:
---

# Plan: Prepared-dish shelf-life class

## Scope

Give cooked/assembled dishes (the output of a `convert`) an honest eat-by. Add a
`prepared` shelf-life class (~4 days, aging from the make date), make `convert`
default its derived item to it, and fix the semantic that a homemade dish's
clock does **not** reset when you open it (`specs/modules/kitchen.md` § Data
model § Shelf-life classes, § Conversions).

Motivating case: the overnight-oats jar minted this session got
`shelf_life_class: fridge_short` → `eat_by` 14 days out, when it's a 3-4-day
item; and a `convert` with no class falls to `unknown` → **no** eat-by, so the
dish is invisible to eat-first ordering.

In scope: the enum value + migration, the day window, the make-date anchoring in
`deriveEatBy`, the `convert` default, and a line of skill guidance. Out of
scope: per-dish shelf-life learning, and any UI.

## Implements

- **§ Shelf-life classes** — new `prepared (4, 4)` class. Unlike the grocery
  classes, its `eat_by` anchors to `acquired_at + window` **regardless of
  `opened_at`** (equal unopened/opened windows encode the intent; `deriveEatBy`
  skips the opened-branch for `prepared`) — a homemade jar ages from when it was
  made, and starting it doesn't grant a fresh window.
- **§ Conversions § Creating the derived item** — `convert` defaults
  `derived.shelf_life_class` to `prepared` (was `unknown`) when omitted, so a
  prepped item always earns an eat-by; a caller overrides for longer/shorter
  dishes (`produce` for hard-boiled eggs, `very_perishable` for cut fruit).

## Approach

- **Migration** — `ALTER TYPE kitchen.shelf_life_class ADD VALUE IF NOT EXISTS
  'prepared'`. PG 12+ allows `ADD VALUE` inside the migration runner's
  transaction as long as the value isn't *used* in the same txn (this migration
  only adds it) — verify against the runner; if it objects, mark the migration
  non-transactional. Additive and safe: existing rows/classes untouched.
- **Types + windows** — add `prepared` to the `ShelfLifeClass` union +
  `SHELF_LIFE_CLASSES` + `SHELF_LIFE_WINDOWS` (`{ unopened: 4, opened: 4 }`) in
  `inventory-types.ts` / `inventory-derive.ts`.
- **deriveEatBy** — for `cls === 'prepared'`, always compute from `acquired_at +
  unopened` (ignore `opened_at`). Everything else unchanged.
- **convert()** — `const cls = derived.shelf_life_class ?? 'prepared'` (was
  `'unknown'`) in `inventory.ts`.
- **Guidance** — the assist-kitchen "I made a batch" workflow / `convert` help
  notes the `prepared` default and when to override.

## Validation

- [ ] `prepared` window is `(4, 4)`; a `prepared` item made day 0 and *opened*
      day 2 still has `eat_by` = day 4 (make-date anchoring), not day 6.
- [ ] A source-less `convert` with no `shelf_life_class` yields a `prepared`
      derived item with a non-null `eat_by` ~4 days out (regression on the jar
      case); an explicit `produce` override still wins.
- [ ] Enum migration applies cleanly; `check` + full kitchen suite green;
      `check:skills` clean after the guidance/help edit.
- [ ] pg + memory stores agree on the derived `eat_by` for a `prepared` item.

## Risks / unknowns

- **`ADD VALUE` transactionality** — the one migration-runner wrinkle; resolved
  by the runner check above (non-transactional fallback if needed).
- **Existing derived items** — none need backfill (the one live derived item,
  the oats jar, is already consumed/terminal). If derived items accumulate before
  this ships, a one-line backfill (`UPDATE … SET shelf_life_class='prepared',
  eat_by=…` WHERE the item has a derivation row and class in
  (`unknown`,`fridge_short`)) is a follow-up, not part of this plan.

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
