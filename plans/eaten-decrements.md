---
status: planned
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

- [ ] An `eaten` submission whose components name divisible items decrements each
      by `grams / net_content_g`; the item's `on_hand_fraction` moves by the
      stated amount and the depletion records as consumption (not a recount).
- [ ] A counted component decrements whole units, and a counted item reaching
      zero closes as `finished` (consumed), never `tossed`.
- [ ] A component naming a product but no item decrements nothing.
- [ ] A divisible item whose product lacks `net_content_g` is NOT decremented,
      and the shortfall surfaces in the entries question queue.
- [ ] A counted item whose product lacks `unit_edible_g` is refused at publish
      time (the panel cannot be computed) rather than at submit time.
- [ ] The journal entry exists even when every decrement fails.
- [ ] Replaying a submission (same `submission_key`) neither double-logs nor
      double-decrements.
- [ ] No comment in the module still claims a depletion matcher exists.

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

*Populated at closeout.*

## Follow-ups

*Populated at closeout.*
