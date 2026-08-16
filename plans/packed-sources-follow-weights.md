---
status: in-progress
depends: []
specs:
  - specs/modules/kitchen.md
issues: [208]
---

# Plan: a packed batch's sources follow the submitted weights

## Scope

Make a `packed` cook-mode sheet decrement the quantities the human actually
entered, instead of amounts frozen when the sheet was published.

- **`prep`** emits `consumes` bindings for `packed` as well as `eaten` — the
  gate that restricts them to `eaten` is the whole defect.
- **`cook-mode`** resolves those bindings into concrete `sources` *before*
  planning the conversion, merged with any explicit `--source` entries.
- **`convert`** gains a gram-denominated source amount, so a binding stated in
  grams does not have to be pre-divided into a fraction by the caller.
- **`components_per`** (`batch` | `unit`, default `batch`) declares whether a
  sheet's component quantities describe one unit or the whole batch.

**Out of scope**: changing how `eaten` decrements (it already follows submitted
weights); a UI for editing sources after publish; retroactively fixing sheets
already submitted.

## Implements

- **specs/modules/kitchen.md § A packed batch's sources follow the submitted
  weights** — the whole behavior.
- **specs/modules/kitchen.md § Eaten sheets decrement their sources** — the
  correction to the depletion-matcher claim (see Notes).

## Approach

**Reuse the eaten path's mechanism, not its shape.** `consumes` already binds a
component label to an item ULID and resolves against the submitted quantity;
that machinery is right and only its gate is wrong. But `eaten` applies its
decrements *after* the entry, best-effort, because the entry must never be
rolled back by a depletion. `packed` has no such constraint — its one write is
already a transaction — so bindings are resolved into `sources` and handed to
`convert`, preserving atomicity rather than trading it away.

**Grams belong in `convert`, not in the caller.** The service already plans
every decrement before the store applies them
(`ConversionWrite` — "the service decides WHAT each write is"). Resolving grams
against `net_content_g` is exactly that kind of planning, and doing it there
keeps one refusal path for a missing basis instead of two.

**The per-unit declaration is stated, never inferred.** See the spec section;
`units: 3` means opposite things on the farro and oat-jar sheets and nothing in
the data distinguishes them.

## Validation

- [x] A packed sheet with a component-bound source decrements the SUBMITTED
      quantity, not the published one.
- [x] `components_per: 'unit'` multiplies the decrement by `units`; `batch`
      (and an omitted value) does not.
- [x] An explicit `--source` that names no component still decrements its fixed
      amount, unchanged.
- [x] A gram-denominated source against an item whose product has no
      `net_content_g` is REFUSED with the basis-rule message — never guessed.
- [x] The conversion remains ONE atomic write: a refused source leaves no
      earlier source spent and no derived item created.
- [ ] Replay of the same submission ULID neither re-decrements nor re-creates.

## Risks / unknowns

- **Double-decrement if a source is named both explicitly and as a binding.**
  The merge must let the binding win rather than applying both. This is the
  most likely way to ship a bug that looks like success.
- **`components_per` defaults to `batch`**, which silently under-decrements a
  per-unit sheet whose author forgets the flag. Considered defaulting to
  `unit` when `units > 1`; rejected — that is exactly the inference the spec
  forbids, and the farro sheet would break under it.
- **Counted sources** already take integer units and need no basis, so they are
  unaffected by the grams work but still need the `components_per` multiplier.

## Notes

**A false claim in the spec surfaced while reading for this change.** The
§ Eaten sheets section asserted "There is no depletion matcher... none was ever
built". A matcher was built 2026-07-18 (`matchAndDeplete`) and is wired at
`packages/kitchen/src/index.ts`. Five code comments were rewritten on the strength
of that false claim in 40d02f6.

The true statement is narrower and more interesting: the matcher fires from
`onEntryEstimated`, and a directly-stated worksheet entry is born terminal with
no estimation pass — so the hook never fires for it. **The most precisely
measured meals were the only ones that subtracted nothing.** Same conclusion,
different cause, and the difference matters because the matcher does still run
for model-estimated entries.

The lesson worth keeping: "I cannot find it" became "it was never built" without
a grep. The corrected text is in the spec; the code comments are corrected here.
