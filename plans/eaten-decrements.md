---
status: done
depends: []
specs:
  - specs/modules/kitchen.md
issues: []
---

# Plan: close the eaten-decrement loop

## Scope

Make a cook-mode `eaten` submission decrement the stock its components name, so
that eating finally subtracts from inventory.

- **`prep publish` carries source identity through.** `--component-item
  <item-ulid>=<qty>` already resolves an item to its product to read the panel;
  the item ULID and quantity now also ride into the definition's `cook_mode` as
  the decrement instruction. `--component <product-ulid>` (no item) stays
  panel-only — a product is not stock.
- **Counted components are stated in UNITS**, divisible ones in grams
  (§ The basis rule). The CLI accepts `<item-ulid>=3u` (or `--component-unit`)
  for the counted form and rejects a grams quantity against a counted item.
- **Decrement on submit**: divisible → `grams / net_content_g` as a fraction;
  counted → integer units. Reuses the existing `eat` / `finished-unit` paths
  rather than a second depletion implementation.
- **Missing basis → no decrement, recorded and surfaced** through the
  § Unreviewed entry notes question queue.
- **Entry lands first, unconditionally**; decrement failures never roll it back.
- Remove the comments across the module that assert a depletion matcher exists.

**Out of scope**: a general depletion matcher for non-sheet meals (restaurant
food, ad-hoc logging). Those mostly are not from tracked stock, and guessing
which item a free-text meal consumed is exactly the inference this spec forbids.
Also out of scope: backfilling historical drift — a one-time recount is the
owner's call, not a migration's.

## Implements

- **specs/modules/kitchen.md § Eaten sheets decrement their sources** — the whole
  section.

## Approach

**The sheet is the only honest decrement instruction available.** It names the
item and the quantity, and the human corrects the quantity as they build. Every
other candidate — matching a free-text meal to stock, inferring from a recipe,
periodic reconciliation — has to guess which item was consumed, and a wrong
decrement is worse than none because it silently corrupts a denominator.

**Refuse-don't-infer is inherited, not new.** `eat --grams` already 400s without
`net_content_g`, and `unit_edible_g` is already STATED-only. This plan extends
the same discipline to a new caller rather than negotiating it.

**The ordering is a principle, not a convenience.** The entry commits before any
decrement is attempted, because logging must beat not-logging: a meal that
refused to record because a bag lacked a net weight would be a worse ledger than
one that records the meal and flags the gap. This deliberately relaxes cook
mode's one-write-per-disposition rule for `eaten` — and the relaxation is
one-directional and stated in the spec so it is not read as license generally.

## Validation

- [x] An `eaten` submission whose components name divisible items decrements each
      by `grams / net_content_g`; the item's `on_hand_fraction` moves by the
      stated amount and the depletion records as consumption (not a recount).
- [x] A counted component decrements whole units, and a counted item reaching
      zero closes as `finished` (consumed), never `tossed`.
- [x] A component naming a product but no item decrements nothing.
- [x] A divisible item whose product lacks `net_content_g` is NOT decremented,
      and the shortfall surfaces in the entries question queue. (The module's
      existing refusal to guess a mass basis IS the signal — the catch reports
      it rather than a second check re-deriving the same condition.)
- [x] A counted item whose product lacks `unit_edible_g` is refused at publish
      time (the panel cannot be computed) rather than at submit time.
- [x] The journal entry exists even when every decrement fails.
- [~] Replaying a submission (same `submission_key`) neither double-logs nor
      double-decrements. **Entry idempotency is enforced** (decrements run only
      on `created`), and `consumeStatedAmount` carries its own `entry_ulid`
      replay guard. The counted path relies on `created` alone — not separately
      exercised against a live replay.
- [x] No comment in the module still claims a depletion matcher exists.

## Risks / unknowns

- **Grams-to-fraction assumes the package was full when tracked.** `net_content_g`
  describes a sealed package; an item opened before tracking began has a fraction
  that never corresponded to that mass. The decrement will be proportionally
  wrong for such items. Probably acceptable — it is far better than no decrement
  — but worth stating rather than discovering.
- **Duplicate products split the basis.** The instance has two near-identical egg
  products where one carries `unit_edible_g: 50` and the other `null`, so whether
  a decrement works depends on which row a receipt happened to match. Product
  merging is the fix and is out of scope here, but it will make this feature look
  flaky until done.
- **A counted component stated in units changes the sheet's shape** for anyone
  already building sheets with grams. New surface, no existing callers, so the
  cost is documentation rather than migration.

## Notes

**The seam already existed in the other direction.** `packed` had `sources`;
`eaten` needed the same idea bound differently — by component LABEL rather than a
fixed amount, so the decrement follows the quantity the human states at submit
time rather than the planned default. `request.components` already carried the
submitted quantities, so the sink resolves each binding against them.

**Two existing refusals became the implementation.** `consumeStatedAmount`
already 400s without `net_content_g`, and `unit_edible_g` was already
STATED-only. Rather than re-deriving those conditions, the catch around the
depleter reports whatever the module refused — so the "unapplied" path is the
existing guard made visible instead of a parallel rule that could drift from it.

**The counted per-basis arithmetic was wrong first time**, caught by the test
that asserted a real macro figure rather than just a shape: the worksheet
computes `quantity / basis * per_basis` with `basis = 100`, so scaling a
per-100g panel by `unit_edible_g / 100` divides by 100 twice. It must be
`per100g * unit_edible_g`. Worth naming — a shape-only assertion would have
passed a sheet that under-reported every counted component by 100x.

**Live confirmation of the refuse-don't-infer rule**, from the instance this was
written for: an egg product carries `net_content_g: 681` for 12 eggs. Deriving a
per-unit basis gives 56.75 g — the IN-SHELL weight. The edible mass is ~50 g.
Net-over-count would have been wrong by exactly the shell, which is the
"wrong in either direction" case the spec names.

## Follow-ups

- **Issue** — non-sheet meals (restaurant, ad-hoc free text) still decrement
  nothing. Out of scope by design, but it means the loop closes only for
  cooked-at-home food, and the ledger will still drift on everything else.
- **Issue** — an item opened BEFORE tracking began has a fraction that never
  corresponded to `net_content_g`, so its grams-to-fraction decrement is
  proportionally wrong. Flagged as a risk in this plan; unaddressed.
- **None** on the counted path: `unit_edible_g` is now set on the products that
  lacked it, stated from the USDA large-egg standard rather than derived.
