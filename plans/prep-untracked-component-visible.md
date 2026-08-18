---
status: in-progress
depends: []
specs:
  - specs/modules/kitchen.md
issues: [207]
---

# Plan: an unbound `--component` on a `--cook` sheet is visible, not silent

## Scope

`prep publish --cook eaten` (and `--cook packed`) promises that submitting the
sheet IS the write. A component bound with `--component-item` / `--component-unit`
binds to an inventory ITEM — stock — and decrements it. A component bound with
`--component <product-ulid>` binds to a catalog row — a product — which carries
no stock to decrement, and never has. Both forms are accepted on the same
`components` array with no distinction, and the resulting sheets render
identically: same table, same weigh-and-submit, same "logged" confirmation. A
real sheet published with product-only components logged a correct journal
entry and moved no stock at all; the drift was caught days later by
hand-counting physical items (claude-assist#207).

- **In scope**: `PrepService.publish` marks a `--component` (product-only) row
  on a `--cook` sheet — visibly, on the rendered page, and in the CLI's
  publish reply — as not bound to stock. Applies to both `eaten` and `packed`
  dispositions, since both bind components to stock the same way
  (§ A packed batch's sources follow the submitted weights).
- **Out of scope**: `--recipe`-seeded rows. They carry no product/item
  reference at all by construction — there is nothing to bind them to, ever —
  so marking them would be true of literally every recipe-seeded sheet and
  would be noise, not information. This is a distinct, pre-existing property
  of recipe seeding, not the defect #207 reports.
- **Out of scope**: refusing the publish outright. See Approach for why.
- **Out of scope**: any pages-module schema change. The fix reuses the
  worksheet's existing per-component `note` field (already rendered under the
  label on the page), so it stays entirely inside the kitchen module — no
  cross-module contract change, no migration.

## Implements

- **specs/modules/kitchen.md § An unbound component is VISIBLE, never
  indistinguishable** (new subsection) — the behavior itself.
- **specs/modules/kitchen.md § Authoring a prep worksheet** — the
  `--component` / `--component-item` bullets now state which one binds.

## Approach

**Decision: warn visibly, don't refuse.** The issue asks for one or the
other and gives the test for choosing: refusing is defensible on the same
grounds the module already refuses a product with no stored panel — *unless*
there's a legitimate case for an unbound component, in which case the sheet
must carry the fact visibly instead. There is such a case, and a second one
the issue didn't name:

1. **Eating something not tracked as stock at all** — a restaurant meal, a
   gift, a sample. The product record (and its panel) can be entirely real
   without there ever being an inventory item to bind to.
2. **Every `--recipe`-seeded row** has *no* product or item reference
   whatsoever — it carries `per_100g` inline from the recipe. "No binding" is
   the normal, permanent state of a recipe line, not a mistake. Refusing "no
   binding" on a `--cook eaten` sheet would refuse every recipe-seeded eaten
   sheet that has ever worked, which is a much bigger blast radius than the
   bug being fixed.

Refusing would also cut against `specs/diet-journal.md` § Principles
("logging must beat not-logging") by forcing a workaround — fabricating a
throwaway inventory item just to get the sheet published — that produces
worse data than the gap it's closing.

**Reuse the doctrine already in the spec, one step earlier.** § An unapplied
decrement is VISIBLE, never silent already covers a binding whose *basis* is
missing (the item exists, but has no `net_content_g`/`unit_edible_g`) — that
case is surfaced through the entry's note-review queue at submit time. This
fix covers the case one step earlier: no binding was ever attempted, because
`ref.item_ulid` was never set. There's no "intended decrement" to record
against an entry for the queue to carry, because publish time is the only
point that knows a `--component` row exists at all — so the mechanism has to
live at publish time, on the sheet itself.

**Mechanism**: `PrepService.publish` already threads a per-component `note`
straight into the worksheet definition, which the pages module already
renders under the component's label on the page
(`packages/pages/src/worksheet.ts` `renderWorksheetHtml`). No pages-module
change needed. When `input.cook` is set and a component resolves via
`product_ulid` only (no `item_ulid`), `publish` appends
`UNTRACKED_COMPONENT_NOTE` to that component's `note` (composing with an
existing author-supplied note rather than clobbering it), and collects the
component's label into a new `untracked_components: string[]` on
`PrepPublishResult`. `kitchen-axi prep publish` prints that list as a loud,
separate line in its reply, alongside the existing `unknown_fields` line.

**Why not a structured field instead of text.** The pages module's worksheet
validator rejects unknown component keys (`specs/modules/pages.md` § The
worksheet definition), so a new `tracked: false`-style field would be a
cross-module schema change — out of scope, and unnecessary: `note` already
renders visibly in exactly the right place, and the kitchen module keeps
authoring its own vocabulary without teaching it to pages (the same seam
discipline § Where the logic lives already establishes for this endpoint).

## Validation

- [x] `--component` (product-only) on a `--cook eaten` sheet: the resulting
      worksheet component carries a note stating it is not tracked in stock,
      and the label appears in `untracked_components`.
- [x] `--component-item` / `--component-unit` (item-bound): no such note, not
      in `untracked_components` — only a component that could have bound and
      didn't gets marked.
- [x] `--component` with no `--cook` at all: no note, `untracked_components`
      is empty — nothing was promised, so there's nothing to warn about.
- [x] `--component` on a `--cook packed` sheet gets the same marking as
      `eaten` — both dispositions bind components to stock the same way.
- [x] An author-supplied `--component ...` note (`note:` on the ref) is
      preserved, not replaced, when the untracked note is appended.
- [x] `kitchen-axi prep publish` prints the untracked rows as a distinct,
      loud line in its reply.
- [x] `bun test` pass count does not fall; new tests cover the above and all
      pass.
- [x] `bun run build` succeeds.
- [x] `bun run check:skills` passes (kitchen-axi CLI bundle rebuilt via
      `bun run build:cli` after the help-text change).

## Risks / unknowns

- **Scope boundary with recipe seeding could look inconsistent.** A
  `--recipe`-seeded eaten sheet still silently doesn't decrement anything,
  same as before this fix — only explicit `--component` rows are marked. This
  is deliberate (see Approach) but worth flagging: if recipe-to-stock binding
  is ever added, the same visibility mechanism should extend to it rather
  than a new one being invented.
- **A note is easy to skim past.** Rendering as a `<span class="cnote">`
  under the label is the existing convention for component notes, but it's
  not a hard stop the way a `400` refusal would be. Accepted as the right
  trade for the false-positive cost of refusing (see Approach); if this
  proves insufficient in practice, the next escalation is a page-level banner
  when `untracked_components` is non-empty, not a refusal.

## Notes

(none yet — populated at closeout)

## Follow-ups

(none yet — populated at closeout)
