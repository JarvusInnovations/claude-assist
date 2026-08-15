---
status: planned
depends: [pages-axi-worksheet]
specs:
  - specs/modules/kitchen.md
issues: []
---

# Plan: `kitchen-axi prep` — author a prep worksheet from the catalog

## Scope

The ergonomic authoring path for cook-mode worksheets, living in the domain that owns
the reference values.

- `kitchen-axi prep publish --slug <slug> --label <label>` with:
  - `--component <product-ulid>=<grams>` — resolve the product, read its stored panel,
    derive `per_basis` by the module's own panel scaling (§ Nutrition panel).
  - `--component-item <item-ulid>=<grams>` — same, resolved via an inventory item's
    linked product, so a sheet can be written against real stock.
  - `--recipe <ulid>` — seed components from a recipe's lines.
  - `--cook eaten` | `--cook packed [--units N] [--shelf-life <class>]
    [--source <item-ulid>[:amount]]…` — emitted into the definition's `cook_mode`.
  - `--step <text>` (repeatable).
- Print the published URL **plus the derived totals at planned quantities**, so the
  author can sanity-check before sending.
- Publishing writes **nothing** to the ledger.

**Out of scope**: changes to cook mode's submission handling (already shipped and
working), and the pages CLI (generic, untouched).

## Implements

- **specs/modules/kitchen.md § Authoring a prep worksheet — `kitchen-axi prep`** — the
  whole command.

## Approach

The point of this command is that **hand-assembling a definition re-derives numbers
the module already stores**, which is the estimation-by-recall failure § Nutrition
panel exists to prevent, reappearing in the authoring path. Every `per_basis` block
must come from the catalog by the same scaling path a logged meal uses — never from a
second implementation, and never transcribed.

A missing field on a product's panel contributes **unknown**, never `0` — the null
semantics are already settled module-wide and this command inherits them rather than
inventing a local convention.

Composition, not coupling: this builds a definition and publishes it through the pages
API. Kitchen depends on pages; pages never on kitchen.

## Validation

- [ ] `prep publish` with two `--component` flags produces a page whose `per_basis`
      values equal what the products' panels yield under § Nutrition panel scaling —
      asserted against the same helper the entry path uses, not a copy.
- [ ] A product missing a panel field yields `unknown` for that field in the totals,
      not `0`.
- [ ] `--cook eaten` submission writes one born-`manual` terminal entry; `--cook
      packed` writes one conversion (sources decremented, derived item created) and
      **no** journal entry.
- [ ] `prep publish` leaves inventory and entries untouched at publish time.
- [ ] Printed planned-quantity totals match the page's own displayed totals before any
      input is edited.
- [ ] `--component-item` resolves through to the linked product, and errors clearly
      when an item has no product link.

## Risks / unknowns

- **A recipe's lines may not map cleanly onto weighable components** (an ingredient
  with no product link, or a line that is an instruction). `--recipe` should seed what
  it can and report what it skipped rather than silently dropping rows.
- **`packed` carries the most surface** — units, shelf-life class, sources — and is
  the disposition with real ledger consequences on submission. Worth landing `eaten`
  first and exercising it before wiring `packed` sources.

## Notes

*Populated at closeout.*

## Follow-ups

*Populated at closeout.*
