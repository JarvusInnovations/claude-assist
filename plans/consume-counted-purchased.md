---
status: done
depends: [product-unit-grams, item-state-fidelity]
specs:
  - specs/modules/kitchen.md
issues: []
pr: 175
---

# Plan: one-tap consume for counted purchased items

## Why

`POST /inventory/:ulid/consume` currently admits one macro-inheritance channel: a
derived item whose `convert` attached a `recipe_ulid`. Everything else is
`400 ConsumeIneligibleError` and falls back to the photo/estimator path.

That drew the line at the wrong place. The test consume actually needs is **does the
module know the panel and know the portion** — and a counted purchased multipack
satisfies it exactly as well as an oat jar does, once
[`product-unit-grams`](product-unit-grams.md) lands. A sealed unit of a tracked
product has a panel on file and an unambiguous portion.

The cost of the narrow rule is a model call for a fact the ledger already holds: an
egg, a can, a link logged from stock get an *estimate* whose portion basis is the
model reconstructing a standard unit weight the product row could have stated. The
depletion links correctly; only the numbers are guessed.

## Scope

1. **Spec** — § Consume from inventory § Eligibility restated as the two-family
   test, with purchased fraction items explicitly refused.
2. **Eligibility predicate + macro resolution** — the only code that changes.
3. **CLI/API** — the ineligibility surface reflects both channels.

**Out of scope, with reasons:**

- **The atomic transaction, idempotency, and depletion semantics.** Unchanged. This
  plan widens a gate; `ConsumeStore.consume` is not touched.
- **Purchased fraction items.** Deliberately never eligible — see Approach.
- **The app's consume shelf.** A separate repo; it follows the server's eligibility
  flag rather than re-deriving the rule.

## Implements

- `specs/modules/kitchen.md` § Consume from inventory § Eligibility — the two
  families, the `per_100g × unit_edible_g ÷ 100` per-unit computation, the
  `reference`-provenance acceptance, and the fraction refusal.

## Approach

- **Change the predicate and the macro-resolution step; nothing else.** Both
  families must produce an identically-shaped entry or downstream rollups diverge.
  They reconcile cleanly because the per-unit recipe contract (amended 2026-07-22)
  already established *one tap = one unit = one unit's macros* on the derived side —
  the product-panel side is the same semantics reached by a different route.
- **`reference`-sourced panels qualify.** The bar is determinism, not SKU-precision:
  a generic-but-correct panel for a whole unit is exact arithmetic on an approximate
  input, which strictly beats a model call on the same input. Refusing it would keep
  the estimator in the loop for the exact foods this exists to remove it from.
- **Purchased fraction items are refused on principle, not oversight.** A divisible
  container has no natural unit, so "eat one" is meaningless and finishing the whole
  thing in one tap is almost never the real act. Their honest path is a stated
  weight (§ Stated-weight consumption). Expect this boundary to be pushed on —
  "eat some of the tub" is a real desire — and the answer is a weight, not an
  eroded rule.
- **Eligibility lives server-side only.** One rule, one place; clients read a flag.

## Validation

- [x] `bun run test`, `bun run build`, `bun run type-check:axi`, `bun run
      check:skills` green.
- [x] One tap on a counted purchased item logs `per_100g × unit_edible_g ÷ 100` and
      decrements one unit; `quantity: n` scales both.
- [x] The multipack regression: a 3-can pack whose product declares an 85 g label
      serving against a ~142 g unit logs **the unit**, not the serving.
- [x] A counted item whose product has a panel but no `unit_edible_g` is
      `400 ConsumeIneligibleError`.
- [x] A purchased **fraction** item is refused regardless of panel completeness.
- [x] A `reference`-provenance panel is accepted; the entry carries no model call
      and no estimator confidence.
- [x] Derived-item consume is byte-identical to before — the per-unit recipe
      contract and fraction whole-batch semantics are untouched.
- [x] Terminal items are still rejected `409`, checked before eligibility.

## Risks / unknowns

- **Two macro sources, one action.** Entry shape must not diverge between channels;
  the per-unit contract is what makes them reconcilable, and a shared assertion on
  entry shape is the guard.
- **Shelf noise.** Every counted purchased item with a complete product row becomes
  a candidate, which on a full pantry is a long strip. Eat-first ordering probably
  suffices; if it does not, the answer is **ranking, not narrowing eligibility** —
  narrowing would re-introduce the estimator for known foods.
- **`unit_edible_g` quality is inherited.** A wrong unit weight now produces a
  confidently wrong entry with no confidence score attached to warn anyone. The
  stated-never-derived rule and its test are what this leans on.

## Notes

- **Priority order, not a merged OR.** `resolveConsumeMacros` tries the derived
  (recipe) channel first and returns immediately on success; the product-panel
  channel is only consulted when channel 1 doesn't apply. This is what makes
  "derived-item consume is byte-identical" true even for a derived item that
  also happens to carry a complete-panel, `unit_edible_g`-bearing product link
  — pinned by a dedicated test (`services/inventory.test.ts`, "a derived item
  with a resolvable recipe ignores a linked product entirely").
- **A broken derivation now falls through instead of hard-failing.** Before
  this plan, `derivedFrom.recipe_ulid` present but unresolvable (recipe
  missing / no components) threw `ConsumeIneligibleError` immediately. It now
  falls through to try the product-panel channel before giving up — more
  permissive, and no existing test exercised the combination (broken
  derivation + eligible product link), so nothing regressed.
- **`nutrition_source: 'estimate'` does NOT qualify the product-panel
  channel**, even with a complete panel + stated `unit_edible_g`. The spec
  text only calls out that `'reference'` qualifies (contrasting it with
  `'label'`); it doesn't explicitly rule `'estimate'` in or out. Excluding it
  is a judgment call, reasoned from the surrounding principle
  ("a caller that knows the answer states it; the system never re-guesses
  it") — an `'estimate'` is by definition a guess already sitting in
  storage, and treating it as deterministic at consume-time would launder
  that guess as fact with no confidence score attached, which is exactly the
  failure the eligibility rule exists to prevent. Locked in by a test; worth
  a second look if it surprises anyone.
- **Environment note (unrelated to this diff):** a fresh worktree needed
  `bun install --linker=hoisted` — the default `isolated` linker didn't
  materialize `@jarvus/*` workspace symlinks in this environment — and `bun
  run build` before `bun run test`, since two unrelated packages
  (`session-spawn`, `capture`) import `@jarvus/claude-assist-core`/`-notify`
  by their built `dist/` entrypoint, which doesn't exist until `build` runs.
  Neither package is touched by this plan.

## Follow-ups

- **Shelf noise risk (flagged in Risks above) is real and not yet addressed.**
  Every counted item with a complete product row now qualifies, which on a
  full pantry turns the consume shelf into a long, undifferentiated strip.
  This plan intentionally does not narrow eligibility to compensate (that
  would reintroduce the estimator for known foods) — the fix is ranking, not
  narrowing. No plan yet owns the ranking work; Tracked as: watch the consume
  shelf after this ships and open a plan for eat-first-based ranking if it
  turns out eat-first ordering alone doesn't cut it.
