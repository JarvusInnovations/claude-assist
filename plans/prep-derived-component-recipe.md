---
status: in-progress
depends: [kitchen-prep-sheets, eaten-decrements]
specs:
  - specs/modules/kitchen.md
issues: [199]
---

# Plan: a counted derived component resolves its panel through its recipe

## Scope

`prep publish --component-item <item-ulid>=<grams>` / `--component-unit
<item-ulid>=<units>` refuses any item with no `product_ulid`, including a
**derived** item (the output of a `packed` batch), because it resolves a
component's panel exclusively through `InventoryStore.getProduct`. A derived
item has no product by construction, so a sheet can never reference the stock
most worth referencing — short-clocked, easily forgotten batches (hard-boiled
eggs, prepped jars).

- **In scope**: when `--component-unit` (`counted: true`) names an item with
  no `product_ulid` but a derivation carrying a `recipe_ulid`, `PrepService`
  resolves `per_basis` from that recipe instead of a product panel, reusing
  `computeRecipeMacros` — the same computation and the same merged
  (sheet + pushed + promoted) recipe universe `consume` reads for its own
  derived-item channel, so the two surfaces cannot disagree about what one
  unit of a batch costs.
- **In scope**: refuse clearly, not silently, when a derived item is named
  with `--component-item` (grams) instead of `--component-unit` (no
  `net_content_g` exists to divide by), or when it isn't actually
  counted-modeled (`units_total` unset — its recipe describes the whole
  batch, not one unit).
- **Out of scope**: a fraction-modeled derived item (e.g. a divisible batch of
  cooked quinoa). Its recipe describes the whole batch with no absolute mass
  to anchor a per-100g basis, and a sheet has no analog of `consume`'s single
  all-or-nothing tap. Stays refused — see Risks.
- **Out of scope**: upgrading `--recipe <ulid>` seeding (a separate, existing
  code path) to the merged recipe universe. It stays DB-only, an existing gap
  this plan does not touch.

## Implements

- **specs/modules/kitchen.md § Authoring a prep worksheet — `kitchen-axi
  prep` § A derived component resolves through its recipe, not a product** —
  the whole subsection (new).

## Approach

`PrepService` gains a fourth, optional collaborator: `resolveRecipe?:
(recipeUlid) => Promise<RecipeRecord | null>`, mirroring
`InventoryPipeline`'s own `resolveRecipe` config exactly — both must resolve
across the same merged universe, or the sheet and `consume` would disagree
about which recipes are usable for the very same item. The server wires both
from one shared closure over `pipeline.listAllRecipes()` (previously
duplicated per-consumer; now a single `resolveMergedRecipe` in `index.ts`).

In `PrepService.publish`, when a component's `item_ulid` resolves to an item
with `product_ulid: null`:

1. Refuse unless `ref.counted` (i.e. the CLI's `--component-unit` form) —
   grams-based reference has no mass basis for a derived item.
2. Refuse unless `item.units_total != null` — a fraction-modeled derived item
   fails the per-unit contract's precondition.
3. Look up the item's derivation (`InventoryStore.getDerivationsByDerivedItemUlids`)
   and its `recipe_ulid`; refuse if absent.
4. Resolve the recipe via the injected `resolveRecipe`; refuse if not found
   or componentless (mirrors `resolveDerivedMacros`'s `null` case in
   `services/inventory.ts`).
5. `computeRecipeMacros(recipe)` with **no** quantity override — every
   component contributes its own `default_qty_g`, which is exactly what "the
   recipe describes one sealed unit" means, and the identical call
   `consume`'s channel 1 makes.
6. Convert the recipe's one-unit total into the worksheet's `per_basis`:
   since the worksheet's basis is fixed at 100 regardless of what a
   component measures in, `per_basis = total × 100` (so that `quantity/100 *
   per_basis == quantity * total` for `quantity` units) — no further scaling
   by a per-unit mass, unlike a product's per-100g panel, because the recipe
   total already **is** one whole unit's macros.

The `consumes` binding (`{component, item_ulid, model: 'counted'}`) needs no
change: `finishUnit` (→ `applyEvent(..., 'finished-unit', ...)`) already
depends only on the item's count model, never its product, so it decrements a
derived item exactly as it does a purchased one once the panel resolves.

## Validation

- [x] A counted component naming a derived item (no product, `units_total`
      set, a derivation with `recipe_ulid`) resolves `per_basis` from the
      recipe, asserted against a **hand-computed macro figure** (not shape
      only) for a two-ingredient recipe.
- [x] `computeRecipeMacros` is called with no quantity override, so
      `default_qty_g` drives the total — asserted by constructing a recipe
      whose components have different quantities and checking the total
      matches summing each at its own default, not a shared/misapplied one.
- [x] `--component-item` (grams, `counted` unset) against a derived item is
      refused with a clear message. (Reuses the phrase "no linked product" —
      it's accurate for both an ordinary unlinked item and a derived one
      referenced the wrong way — but names the fix: "resolves its panel
      through its recipe only when referenced as counted".)
- [x] A derived item with `units_total: null` (fraction-modeled) referenced
      with `--component-unit` is refused, not resolved as if counted.
- [x] A derived item whose derivation carries no `recipe_ulid`, or whose
      `recipe_ulid` resolves to nothing / an empty-component recipe, is
      refused with a clear message.
- [x] The `consumes` binding for a resolved derived component is `model:
      'counted'`, unchanged in shape from the purchased-item case.
- [x] Existing product-panel behavior (purchased items, `--recipe` seeding)
      is unchanged — the full existing `prep.test.ts` suite still passes
      unmodified in its old assertions.
- [~] End-to-end against a running server (publish a sheet against a real
      derived item, submit it as `eaten`, confirm the unit decrements and the
      entry's macros match). **Not run** — no live server/DB in this
      environment; same limitation the `kitchen-prep-sheets` plan's
      Follow-ups already recorded for `--component-item`.
- [x] `bun install`, `bun run build` (the CI gate), `bun run test` (all
      packages, kitchen: 842 pass / 0 fail), `bun run check:skills`, and
      `bun run type-check:axi` all pass clean.

## Risks / unknowns

- **Fraction-modeled derived items stay unreachable from a sheet.** Their
  recipe describes the whole batch, not a per-gram basis, and `consume`'s own
  model for them is a single all-or-nothing tap with no partial-mass
  concept — a sheet's stated-grams input has nothing to scale against. This
  was the issue's own framing (both worked examples — hard-boiled eggs,
  prepped jars — are counted), so it is treated as correctly out of scope
  rather than an oversight, but it means a divisible prepped batch (e.g.
  cooked quinoa) still cannot be referenced from a sheet. Confirmed against
  the spec (§ Consume from inventory § Macro inheritance) rather than
  assumed.
- **The per-unit recipe contract's guarantee is a naming convention, not an
  enforced invariant.** Nothing stops a recipe linked to a counted derived
  item from actually describing more or less than one unit (e.g. a recipe
  authored for "the whole dozen" mistakenly linked to a per-egg derived
  item) — the module trusts the link the same way `consume` already does.
  This plan does not add a new check here; it inherits the existing trust
  boundary rather than second-guessing it.

## Notes

**The merged-recipe resolver was a pre-existing but under-shared seam.**
`InventoryPipeline`'s `consume()` already resolved a derived item's
provenance recipe across the full sheet+pushed+promoted universe
(`resolveRecipe`, composed in `index.ts` from `pipeline.listAllRecipes()`),
but `PrepService`'s existing `--recipe` seeding channel used only the
DB-only `RecipeStore` (`recipes.get()`). Verifying this in the spec (as
directed) before relying on it turned up a real correctness question: should
the new derived-item resolution reuse the merged resolver, or accept the
same DB-only narrowing `--recipe` seeding already has? Chose the merged
resolver — the spec states the per-unit contract in terms of the merged
universe (§ Consume from inventory § Eligibility explicitly allows
sheet-sourced recipes), so a DB-only lookup here would let `prep publish`
refuse a batch that `consume` accepts for the very same item, which is
exactly the kind of surface disagreement the module works hard to avoid
elsewhere. Extracted the previously-inline closure in `index.ts`
(`resolveMergedRecipe`) so both `InventoryPipeline` and the new
`PrepRoutesConfig.resolveRecipe` share one definition instead of drifting
into two.

**`--recipe <ulid>` seeding stays DB-only** (unchanged, out of scope) — the
`kitchen-prep-sheets` plan built it against `RecipeStore` directly, and nothing
here required touching it. It is now the one asymmetric channel: seeding
reads DB-only, derived-component resolution reads the merged universe. Worth
knowing, not urgent — see Follow-ups.

**The arithmetic was checked against a real macro figure, not just a shape**,
per the explicit instruction (a prior bug in this exact spot — the counted
purchased-item scaling — was a 100x double-division caught only by a
value-level assertion). For a one-component recipe (50 g egg, 155 kcal/100g,
12.6 g protein/100g): one unit's recipe total is 77.5 kcal / 6.3 g protein
(`computeRecipeMacros` with no quantity override — same number a direct
recipe-logged entry or `consume` would show). `per_basis = total * 100` =
7750 / 630. Two units on the sheet: `2/100 * 7750` = 155 kcal, `2/100 * 630`
= 12.6 g — recovering the exact per-unit numbers doubled, confirming the
`* 100` (not `/100` again) is right. A second, two-ingredient recipe (80 g
oats + 100 g yogurt, different `default_qty_g` each) confirmed
`computeRecipeMacros` sums each component at its own default rather than a
shared one: 311.2 + 59 = 370.2 kcal for one unit, not a wrong number that a
shape-only assertion would have missed.

**Decrementing a derived item needed no change.** `finishUnit` (→
`applyEvent(itemUlid, 'finished-unit', …)`) depends only on the item's count
model (`units_remaining`/`units_total`), never on `product_ulid` — confirmed
by reading `services/inventory.ts`, not assumed. Once the panel resolves at
publish time, the existing `consumes` binding (`{component, item_ulid,
model: 'counted'}`) and cook-mode's `applyConsumes` decrement path work
completely unchanged. `consumeStated` (the divisible/grams path) was NOT
extended to derived items — it hard-requires the linked product's
`net_content_g`, which a derived item never has, so a fraction-modeled
derived item stays unreachable from a sheet by the same refusal that already
guards purchased stock with no mass basis. This is consistent with scoping
the fix to counted derived items only.

842 kitchen tests pass (0 fail), including the new derived-component
coverage, plus the full monorepo `bun run build` (the CI-matching gate) and
`bun run test` across every package, `bun run check:skills`, and `bun run
type-check:axi` — all clean.

## Follow-ups

- **Issue** — a fraction-modeled (divisible) derived item still cannot be
  referenced from a prep sheet at all. Its recipe describes the whole batch
  with no absolute per-100g basis, and `consume`'s own model for it is a
  single all-or-nothing tap with no partial-mass concept — a sheet's
  stated-grams input has nothing to scale against. Confirmed as a real,
  structural gap (not just unhandled), not merely deferred; closing it would
  need either a stated total batch mass on the derived item or a different
  sheet semantics for this case. Left open rather than guessed at, per
  refuse-don't-infer.
- **None** on end-to-end server verification — deferred by environment, not
  by design; the `kitchen-prep-sheets` plan recorded the identical gap for
  `--component-item` and it was never separately tracked as an issue, so
  this follows the same precedent rather than opening a new one.
- **None** on `--recipe <ulid>` seeding's DB-only scope. Flagged as an
  asymmetry in Notes, but it predates this plan (`kitchen-prep-sheets`) and
  nothing here regresses or depends on it — left as observed drift rather
  than filed, since fixing it is a small, independent change if anyone hits
  it in practice.
