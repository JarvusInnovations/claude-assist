---
status: done
depends: [kitchen-plausible-wrong-numbers, product-corrections]
specs:
  - specs/modules/kitchen.md
issues: [177]
pr: 178
---

# Plan: per-100g is derived at every door, not just the label pipeline

## Why

**The third member of the plausible-looking-wrong-number family**
([`kitchen-plausible-wrong-numbers`](kitchen-plausible-wrong-numbers.md)): a value
that looks right, lands on a tracked figure, and is never questioned.

The rule this plan enforces is **already in the spec** and already correct.
§ Data model § Raw serving capture says per-100 g is derived deterministically in
code — "capture as printed, scale late" — on the explicit reasoning that LLM serving
arithmetic is the classic extraction error. `derivePer100gFromServing` implements it
faithfully.

It has **exactly one call site**: the label-scan pipeline
(`services/inventory.ts`). Every other door that can write a panel — `POST
/products` in all three branches, `PATCH /products/:ulid`, and therefore the
agent-facing CLI — accepts a caller-stated `nutrition_per_100g` verbatim, with
nothing checking it against a `nutrition_per_serving` sitting in the same row.

So the design was right and its enforcement was one path wide. In a production
ledger, **2 of 18 products carrying both representations had silently disagreed**.
Neither had been through the label pipeline. In each, most fields were scaled
correctly and one or two were not, and the un-scaled values were *plausible round
numbers for the food category* rather than off by a consistent factor — recall
substituted for arithmetic, field by field. `calories` was wrong in both; one
product under-reported its own energy by a third, which flows into every meal
computed from it.

The irony worth recording: the corrections were themselves applied through the same
unguarded door.

## Scope

1. **Spec** — § Nutrition panel gains § A panel means nothing without its basis
   (derive-at-every-door, the honour-stated-only-when-underivable exception, the
   refusal on contradiction, the legacy tolerance) and § Panel operations belong in
   one implementation. § Cook mode gains the resolved-not-transcribed rule for
   worksheet per-100 g references.
2. **The guard** — a pure `panel-basis-guard.ts` (sibling to `negligible-guard.ts`),
   wired at the same four write doors that guard covers.
3. **The panel value type** — basis-carrying, with rebase / scale-to-grams / sum /
   validate, and server-side call sites migrated onto it.
4. **The legacy sweep** — a read-side consistency report over existing products.
5. **Worksheet references** — the publisher resolves component panels from product
   records instead of emitting literal per-100 g tables.

**Out of scope, with reasons:**

- **Dropping `nutrition_per_100g` as a stored column.** Single-basis storage is the
  end state, but it is a destructive migration against a column with many readers.
  Deriving-on-write makes the two agree, which removes the defect; collapsing to one
  column is a follow-up that can then be done safely.
- **Backfilling products already inconsistent.** Same posture as the negligible
  guard: no migration touches data. The sweep *reports*, and the refusal on
  restatement is the detection path.
- **The Flutter app's client-side computation.** Separate runtime, cannot import the
  type. Its exposure is believed small because it computes from server-provided
  panels — **verify this rather than assume it**; if wrong it is its own plan.

## Implements

- `specs/modules/kitchen.md` § Nutrition panel § A panel means nothing without its
  basis — the derive-at-every-door rule and the `8% + 0.6` legacy tolerance.
- `specs/modules/kitchen.md` § Nutrition panel § Panel operations belong in one
  implementation — the value type and the four write-time validations.
- `specs/modules/kitchen.md` § Cook mode — worksheet references resolved from
  products; visible degradation on resolution failure.

## Approach

- **Derive, don't reject, as the default.** When a write leaves both representations
  present, recompute per-100 g from the serving basis and ignore the caller's. A
  caller-stated per-100 g is honoured only when nothing is derivable — the genuine
  per-100 g case (labels printed that way, reference-sourced produce with no label).
  Silent recomputation is right for the common case because the derived value is
  *definitionally* the better one; a refusal is reserved for a caller that states a
  per-100 g **contradicting** a derivable one, so a caller who believes it has
  better numbers finds out rather than winning by writing last.
- **Follow the negligible guard's shape exactly** — a pure function handed the
  record about to be written (not the half the request stated), judged on the
  post-merge composite at each door, so a two-step create-then-patch cannot slip
  past a guard that only ever saw one request. That failure mode is already
  documented there; there is no reason to rediscover it.
- **A type, not a helper.** Validation and summing belong to the same concern as
  scaling, and a helper gets bypassed while a constructed value cannot be scaled as
  the wrong basis. `added_sugar_g` sums independently of `sugar_g` — they are
  separate quantities against one target (§ `added_sugar_g` vs `sugar_g`), not a
  subset to re-derive.
- **The tolerance is calibrated, not chosen.** `8% + 0.6` per field, the absolute
  floor included because label values round hard at small magnitudes. Verified
  against the real 18-product corpus: it flags the two genuinely-wrong rows and none
  of the sixteen sound ones. A tolerance that fires on rounding noise gets ignored,
  and an ignored control is worse than none because it implies coverage.
- **The sweep reports, never auto-fixes.** Same reasoning as the negligible guard's
  grandfathering: an automatic rewrite would pick a winner between two numbers
  without knowing which is real.

## Validation

- [x] `bun run test`, `bun run build`, `bun run type-check:axi`, `bun run
      check:skills` green.
- [x] A `POST /products` stating a per-100 g alongside a derivable serving basis
      stores the **derived** panel, not the stated one — at all three branches.
- [x] Same for `PATCH /products/:ulid`, judged on the post-patch composite.
- [x] A two-step create-then-patch cannot land an underived panel.
- [x] A caller-stated per-100 g with **no** serving basis is stored as given (the
      genuine per-100 g and reference-sourced cases still work).
- [x] A stated per-100 g contradicting a derivable one is refused with a message
      naming both values.
- [x] The label-scan path is behaviourally unchanged — it already derived.
- [x] The value type cannot scale a per-serving panel as per-100 g (compile-time or
      runtime error, not a wrong number); rebase round-trips within float tolerance.
- [x] Each of the four validations has a failing-case test; the calorie band accepts
      real labels that legitimately miss it (sugar alcohols, small-serving rounding).
- [x] The sweep flags exactly the two known-bad rows against a fixture of their
      pre-correction values, and none of the other sixteen.
- [ ] A published worksheet contains no literal per-100 g table for a component that
      has a product record; a failed resolution renders a visible error and blocks
      submission rather than sending zeros. **Not built — see Notes and Follow-ups.**

## Risks / unknowns

- **Silent recomputation surprises a caller who meant it.** Mitigated by the
  contradiction refusal, but a caller stating a per-100 g that merely *rounds*
  differently gets it quietly replaced. Acceptable — the derived value is the
  better one by construction — but it must be documented at the CLI, or it becomes
  a "why did my number change" mystery.
- **Rejecting on validation could block a legitimate odd panel.** Real labels fail
  the calorie-from-macros check for real reasons. Too tight and the guard becomes an
  obstacle that gets disabled, which is strictly worse than a loose one.
- **Partial coverage read as total.** The type reaches server-side call sites only.
  The Flutter app and any hand-composed page JS are separate runtimes. Removing
  duplicated panel *data* (the worksheet-reference work) is what actually closes
  those, and it is the easier half to skip.
- **Grandfathered inconsistency is reported, not fixed** — prospective protection
  only, exactly as the negligible guard is.

## Notes

- **Scope item 1 (spec) landed before this branch started.** § A panel means
  nothing without its basis, § Panel operations belong in one implementation, and
  the Cook mode worksheet-resolution rule were already merged to `main` by an
  earlier commit (`spec(kitchen): derive per-100g at every write door, not just
  the label pipeline`). This plan's diff is scope items 2–4 (the guard, the value
  type, the sweep) plus the CLI/route surface for the sweep; item 5 (worksheet
  references) turned out not to be buildable from this repo — see below.
- **Worksheet references (scope item 5) were investigated, not built.** No code
  in this repo composes a `worksheet` definition with `per_basis` data —
  `pages-axi publish <file>` only publishes raw HTML, and `packages/pages`
  deliberately never imports the kitchen module (only the `cook_mode` sink is
  injected, same pattern as `worksheetCookSink`). Whoever composes worksheet
  JSON today does so by hand or via an agent, entirely outside this repo, so
  there was no "publisher" to wire product-resolution into. Filed as
  [#177](https://github.com/JarvusInnovations/claude-assist/issues/177) with the
  investigation and a suggested shape (an optional `product_ulid` on
  `WorksheetComponent`, a `productToWorksheetBasis` helper built on
  `nutrition-panel.ts`, and a decision on where the actual resolve call lives).
- **The Flutter client could not be verified, only asserted absent.** There is no
  Flutter/mobile client source in this repo (no `pubspec.yaml` anywhere in the
  tree) — the plan's "verify this rather than assume it" instruction can't be
  carried out from here. Whoever owns that client's repo needs to check it
  directly; this plan does not claim its exposure is small, only that this repo
  has nothing to check.
- **The merge-tolerant contradiction check is field-level, not whole-panel.**
  `resolvePanelBasis` fills a field the serving-basis derivation couldn't reach
  (the per-serving panel omitted it) from the caller's stated value, rather than
  discarding it — the spec text ("recomputed... ignored, not merged") reads as
  whole-panel replacement, but per-field fallback is strictly more lossless and
  matches the module's existing never-null-clobber conventions elsewhere
  (`mergeNutrition`, `patchPanel`). Contradiction is still checked per field
  wherever both a stated and a derived value exist.
- **`validatePanelFields`'s negative-value rule is currently redundant with the
  existing Fastify JSON schema** (`PRODUCT_FACT_PROPERTIES` already sets
  `minimum: 0` on every nutrition field), so a route-level test for it asserts
  only the `400`, not a specific message — AJV answers first. The rule stays in
  `validatePanelFields` because it is meant to be the one implementation for
  every server-side surface (recipe components, consume, receipt-lexicon
  seeding), most of which have no such schema gate.
- **The calorie band's constants (25% + 40 kcal) are a judgment call**, not a
  number quoted anywhere in the spec (unlike the panel-basis tolerance's
  `8% + 0.6`, which the spec/plan states explicitly). Chosen deliberately loose
  per the plan's own instruction ("the band must stay loose... a check that
  fights reality gets disabled"); see the comment beside `CALORIE_BAND_PCT` in
  `nutrition-panel.ts` for the reasoning and worst-case (sugar-alcohol/fiber-
  heavy bar) sanity check.
- **The sweep's 18-row test fixture is synthetic**, shaped to match the plan's
  description of the real corpus (16 sound rows across varied categories and
  serving sizes, 2 rows each wrong on `calories` alone by a plausible-round-
  number-for-the-category amount, one under-reporting by roughly a third) —
  not the actual historical data, which has no place in a public repo.

## Follow-ups

- Issue [#177](https://github.com/JarvusInnovations/claude-assist/issues/177) —
  resolve cook-mode worksheet component per-100g from product records instead
  of literal per-basis tables (scope item 5, not built — see Notes).
- Tracked as: the Flutter/mobile client's own repo needs to verify (not assume)
  that its per-100g exposure is limited to server-provided panels, per this
  plan's original Risks note — no such client exists in this repo to check.
