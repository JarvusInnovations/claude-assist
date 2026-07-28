---
status: ready
depends: [kitchen-module]
specs:
  - specs/modules/kitchen.md
issues: []
pr: null
---

# Plan: Split added sugar out of total sugar (nine-field panel)

## Why

The panel tracks `sugar_g` (total) and the daily view draws a ceiling on it. That
ceiling is borrowed: WHO's 10%/5%-of-energy thresholds and the AHA limits govern
*free*/*added* sugars and explicitly exclude the intrinsic sugars in whole fruit
and milk. There is no established total-sugar guideline to draw a line at.

The consequence is not cosmetic. A day of fruit, plain yogurt, and milky coffee
reads "over" while containing almost no added sugar — so the alarm fires hardest
on the owner's *best-eating* days. Observed live: a single day showed "sugar 15.8 g
over" where ~48 g of the total was lactose from coffee and the rest whole fruit,
and the owner had to be talked down from it twice in one session. An indicator that
cries wolf gets ignored, and then it is worse than absent.

Meanwhile the genuinely actionable number is invisible. With mocha syrup, a
vitamin-C drink mix, and sugared fibre supplement all retired from the rotation,
the owner's actual added sugar is near zero on most days — which means a breach
would carry real signal if it were measured.

## Scope

Add `added_sugar_g` as a ninth panel field, move the ceiling onto it, and demote
`sugar_g` to displayed-but-untargeted context. See `specs/modules/kitchen.md`
§ Nutrition panel for the full contract; the decisions there are settled and are
not open for re-litigation in implementation.

1. **Schema + migration.** New nullable `added_sugar_g` on entries and wherever
   the panel is persisted (`nutrition_per_100g` on products/recipe components,
   derived-item macros). Additive, `ADD COLUMN IF NOT EXISTS`, applies on boot.
   Existing rows stay `null` — unknown, correctly, since it was never captured.
2. **Panel plumbing.** `PANEL_FIELDS` in `packages/kitchen/src/types.ts` and its
   mirror in `daily-targets.ts` are the canonical lists; the field must flow
   through every source the spec enumerates — model estimate, recipe/component
   computation, reselect clone, manual override, directly-stated panel,
   consume-from-inventory. `computeRecipeMacros` sums it with the same
   null-vs-zero semantics as the rest.
3. **Estimator.** Prompt and output schema gain the field, with the attribution
   rules from the spec: labels are authoritative, unprocessed whole foods assert
   `0` rather than `null`, prepared/restaurant dishes are a reasoned estimate from
   visible sweeteners, and juice sugar counts as added.
4. **Targets + daily view.** `added_sugar_g` gets the ceiling (default 36 g,
   configurable like the others). **Remove the `sugar_g` ceiling** — it keeps
   appearing in the rollup and the home view as a bare number with no
   over/under verdict.
5. **AXI surface.** `entries log` and `entries patch` both accept
   `--added-sugar`. Use the single-source flag list established by the earlier
   parity fix so `log` and `patch` cannot drift; regenerate the reference and
   SKILL.md.
6. **Display.** The nested bar from the spec: total sugar as the bar's extent,
   added as a filled segment inside it, threshold marker at the added ceiling.
   Wherever the daily view renders target bars.

## Explicitly out of scope

- **Backfilling `added_sugar_g` on historical entries.** They are honestly
  unknown. Do not guess retroactively; `null` is the correct value and the daily
  total for a past day should read null rather than a fabricated zero.
- Re-seeding existing products from labels. A separate operational pass.
- The receipt parser. Receipts carry no nutrition — this lands in product seeding
  and label capture only.

## Risks

- **`null` vs `0` is the whole correctness story here.** A whole food asserting
  `null` instead of `0` silently drops a day's total; a processed food asserting
  `0` instead of `null` fabricates a clean day. Both directions must be tested.
- The `sugar_g` ceiling removal touches the daily-target machinery that several
  other fields share. Removing one field's target must not disturb the others.
- Estimator confidence on prepared dishes will be visibly lower than on labels.
  That is intended, not a defect to engineer away.

## Validation

- Full suite green (`bun run test`), `bun run build`, `bun run type-check:axi`,
  `bun run check:skills`.
- A whole-food entry records `0`, not `null`.
- A day mixing fruit + dairy shows a high `sugar_g` with `added_sugar_g` near zero
  and **no over-ceiling verdict** — the exact false alarm this retires.
- A recipe-computed entry sums `added_sugar_g` across components with correct
  null-vs-zero semantics.
- `entries patch --added-sugar` corrects it on an existing entry without a
  delete-and-re-log.
