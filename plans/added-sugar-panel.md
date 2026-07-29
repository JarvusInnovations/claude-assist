---
status: done
depends: [kitchen-module]
specs:
  - specs/modules/kitchen.md
issues: []
pr: 158
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

- [x] Full suite green (`bun run test`), `bun run build`, `bun run type-check:axi`,
  `bun run check:skills`.
- [x] A whole-food entry records `0`, not `null`.
- [x] A day mixing fruit + dairy shows a high `sugar_g` with `added_sugar_g` near zero
  and **no over-ceiling verdict** — the exact false alarm this retires.
- [x] A recipe-computed entry sums `added_sugar_g` across components with correct
  null-vs-zero semantics.
- [x] `entries patch --added-sugar` corrects it on an existing entry without a
  delete-and-re-log.

## Notes

- **The canonical panel list is `NUTRITION_FIELD_KEYS` in `types.ts`**, not the
  `PANEL_FIELDS` name this plan used — the existing export was kept rather than
  renamed across a dozen call sites. Its scope grew, though: recipe-component
  summing, the product per-100g completeness check, the meal-planning totals, and
  the CLI's effective-macro keys all now derive from it instead of re-enumerating
  the fields. Six hardcoded copies of the list were what made this field addition
  a scavenger hunt; the next one is the interfaces plus one array.
- **`DAILY_TARGET_FIELDS` deliberately does NOT derive from it.** Its divergence
  from the panel (no `sugar_g`) is the feature, so it stays hand-written with the
  reason attached. A config still naming `sugar_g` is **refused at boot** with its
  own message pointing at `added_sugar_g` — not silently dropped (the instance
  would believe it still had a sugar line, and a half-parsed budget is worse than
  none) and not reported as an unknown field (the field exists; it just cannot
  carry a target). Removing one field's line disturbed no other target, pinned by
  a test that configures all eight at once.
- **The nested bar landed as a nested *figure*, because this repo has no
  graphical daily view.** The only daily view here is the CLI home view, so the
  sugar pair renders as ONE value — `62.4 total, added 1.2 / 36 max (34.8 left)` —
  total bare, verdict on the added portion alone. Two peer target lines would be
  the text equivalent of the two bars the spec rejects. The spec was amended to
  say the rule governs the figure rather than the pixels, and that a tabular
  multi-day rollup (`days`) is not a bar and carries both as unjudged columns. The
  app's actual graphical bar lives outside this repo and is untouched.
- **Two spec gaps found while implementing**, both fixed in `84ce237` rather than
  silently diverged from: § Daily targets still listed `sugar_g` as targetable and
  omitted `added_sugar_g` (contradicting the section two above it), and four stale
  "eight-field" counts survived the spec commit.
- **Products seeded before this field now report `needs_nutrition: true`**, since
  the completeness check counts all nine fields and a null one means incomplete.
  That is the intended signal — a label rescan resolves it — but it will light up
  for every existing product at once.
- Verified before opening the PR: `bun run test` → every workspace package
  `0 fail` (kitchen 430 pass, 10 packages all exit 0); `bun run build` → all 14
  packages exit 0; `bun run type-check:axi` clean; `bun run check:skills` reports
  all four bundles and SKILL.mds up to date. Full-diff scrub scan clean.
- **Migration `016-kitchen-added-sugar.sql` has not been run against a live
  database** — additive `ADD COLUMN IF NOT EXISTS`, applies on next boot.
- The three unrelated CLI bundles were reverted after `build:skills` touched only
  their VERSION git-SHA stamp; `check:skills` tolerates that, so the diff stays
  focused on `kitchen-axi.mjs`.

## Follow-ups

- **Tracked here, not fixed — every existing product now reads
  `needs_nutrition: true`.** Re-seeding products from labels was out of scope by
  design; the rescan pass is operational work over real stock, one item at a time,
  and nothing in code can honestly guess the missing line.
- **None for historical entries.** They are `null` on purpose. If a day's added
  sugar is ever wanted retroactively, `entries patch --added-sugar` corrects one
  entry at a time from a human's actual knowledge — there is no batch inference
  worth writing, and a fabricated zero is exactly the failure this field exists to
  avoid.
- **Deferred — a graphical nested bar in the app client.** The spec's display rule
  is satisfied in the only daily view this repo has; the phone client's target
  bars live in another repo and will need the same one-object treatment (total as
  extent, added as the filled segment, marker at the added ceiling) when it picks
  the field up.
