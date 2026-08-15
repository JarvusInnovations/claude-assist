---
status: done
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

- [x] `prep publish` with two `--component` flags produces a page whose `per_basis`
      values equal what the products' panels yield under § Nutrition panel scaling —
      asserted against the same helper the entry path uses, not a copy.
- [x] A product missing a panel field yields `unknown` for that field in the totals,
      not `0`.
- [~] `--cook eaten` submission writes one born-`manual` terminal entry; `--cook
      packed` writes one conversion and **no** journal entry. **The definition's
      `cook_mode` is asserted by test; the submission path itself was already
      shipped and tested by cook mode** — not re-exercised end-to-end against a
      live server here.
- [x] `prep publish` leaves inventory and entries untouched at publish time.
- [x] Printed planned-quantity totals match the page's own displayed totals before any
      input is edited.
- [x] `--component-item` resolves through to the linked product, and errors clearly
      when an item has no product link.

## Risks / unknowns

- **A recipe's lines may not map cleanly onto weighable components** (an ingredient
  with no product link, or a line that is an instruction). `--recipe` should seed what
  it can and report what it skipped rather than silently dropping rows.
- **`packed` carries the most surface** — units, shelf-life class, sources — and is
  the disposition with real ledger consequences on submission. Worth landing `eaten`
  first and exercising it before wiring `packed` sources.

## Notes

**Chris chose the server-endpoint shape (B) over CLI composition (A)** when the fork
was surfaced. The deciding argument was consistency: every other kitchen command is
"a thin veneer over one documented endpoint", and a CLI that assembled definitions
itself would be a second implementation of the panel rules reachable only from a
shell. Both specs now record the decision.

**The seam turned out to already exist.** Core has had a `PagePublisher`
(`fastify.pages`) since the pages module shipped — it just only accepted authored
HTML. Extending it to take `worksheet` was a much smaller change than the new
injection seam this plan budgeted for, and it landed the symmetry cleanly: a
submission travels pages → kitchen via `worksheetCookSink`, an authoring request
travels kitchen → pages via `PagePublisher`. Neither package imports the other.

`worksheet` is typed `unknown` in core on purpose — core owns the seam, not the
shape — and the publisher enforces the same exactly-one-of-html-or-worksheet rule
the HTTP route does, so the in-process door is not a looser way into the store.

**No scaling was reimplemented.** `per_basis` reads the product's stored
`nutrition_per_100g`, which the module already derives from the serving basis at
write time. A product with no panel is refused rather than guessed at; a product
missing one field omits it, so the total reports `unknown` instead of a silent zero
— and the CLI names which fields came back unknown rather than letting a `0` read
as a measurement.

The axi drift guard caught the new command group immediately (it asserts the exact
group list), which is the gate working as designed.

819 kitchen / 138 pages / 15 core tests pass; skills drift gate and axi type-check
clean.

## Follow-ups

- **Issue** — `--recipe <ulid>` (seed components from a recipe's lines) is specced but
  NOT implemented. It was the least-certain part of the plan for a real reason: recipe
  lines don't all map onto weighable components, so it needs a defined skip-and-report
  behavior. Deliberately deferred rather than half-built.
- **Issue** — end-to-end verification against a running server is still outstanding for
  both this and `entry-note-review`; the instance needs migration 022 and a restart.
