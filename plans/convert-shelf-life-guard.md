---
status: done
depends: [kitchen-module]
specs:
  - specs/modules/kitchen.md
issues: []
pr:
---

# Plan: `convert` rejects package-durable shelf-life classes on derived items

## Scope

Restrict `POST /inventory/convert`'s `shelf_life_class` to the **made-food set**
— `prepared` (default), `produce`, `very_perishable`, `frozen` — and reject the
**package-durable classes** `pantry` / `fridge_long` / `fridge_short` with a
`400`. A derived item is `stocked`/unopened by construction, so a package class
anchors its `eat_by` to the long *unopened* window (`fridge_short` 14 d,
`pantry` 365 d), producing an absurd clock on a homemade item that was never a
sealed package. Implements the "A `convert` derived item accepts only made-food
shelf-life classes" rule added to `specs/modules/kitchen.md` § Shelf-life
classes. Observed in use: a Sunday batch (oat jars, cooked quinoa, hard-boiled
eggs) each stamped `fridge_short` → eat-by 14 days out, under-ranking them in
eat-first.

**Out of scope:**

- Changing the `SHELF_LIFE_WINDOWS` day constants — they're correct for the
  purchased goods they model; the bug is *which* classes a derived item may use.
- The `deriveEatBy` opened/unopened logic and the `prepared` make-date special
  case (both correct — unchanged).
- Fixing the three already-mis-classed items from the observed batch (a one-shot
  data correction handled operationally, not in code).

## Implements

- `specs/modules/kitchen.md` § Shelf-life classes — the made-food-only guard on
  `convert`, the rejected package-durable set, and the `400`-with-guidance.

## Approach

- **Validate in the convert path** (`routes/inventory.ts` `POST
  /inventory/convert`, and/or the `services`/`inventory-store` convert entry —
  wherever the `--to` spec is validated): when `shelf_life_class` is present and
  is one of `pantry` / `fridge_long` / `fridge_short`, reject with a structured
  `400` naming the valid made-food set and pointing at `prepared`. Omitted class
  still defaults to `prepared` (unchanged). `frozen`, `produce`,
  `very_perishable`, `prepared` pass.
- Keep the rejection a single shared check so both the HTTP route and any
  internal convert caller enforce it identically.
- **CLI**: `kitchen-axi inventory convert` should surface the same rejection as a
  clean AXI error (structured, points at the valid classes) — validate before
  the call where practical, and pass through the server's structured error
  otherwise. Update the `convert` `--help`/reference to list the valid made-food
  classes.
- **Docs**: note in SKILL.md / reference that a converted item takes only
  made-food classes (`prepared` default), not grocery classes.

## Validation

- [x] `convert --to '{... "shelf_life_class":"fridge_short"}'` returns a `400`
      naming the valid set (`prepared`/`produce`/`very_perishable`/`frozen`) and
      `prepared`; no item is created.
- [x] Same rejection for `pantry` and `fridge_long`.
- [x] `prepared`, `produce`, `very_perishable`, `frozen` each succeed and derive
      the expected eat-by (prepared/produce ages from make-date per existing
      rules).
- [x] Omitted `shelf_life_class` still defaults to `prepared` (4 d from make).
- [x] The reject fires for both the HTTP route and any internal convert caller
      (shared check), and the CLI surfaces it as a structured AXI error.
- [x] `check:skills` passes; convert `--help`/reference lists the valid classes.
- [x] Existing convert/derivation tests still green.

## Risks / unknowns

- **A legitimately shelf-stable made item** (e.g. a homemade dry spice mix that
  really is pantry-durable) can no longer name `pantry`. Judged acceptable:
  it's rare, and the product-level day override is the escape hatch for an
  honest long clock. Note if a real case appears.
- **`frozen` on a derived item** is allowed (freeze a batch flat) and ages from
  make-date via its window — confirm that reads sensibly.

## Notes

- Guard lives in `InventoryPipeline.convert()` (`services/inventory.ts`),
  right after the `derived.name` check — before any source decrement or item
  write, so nothing is created on rejection. Both the HTTP route
  (`POST /kitchen/inventory/convert` → `ConversionValidationError` → 400) and any
  internal `convert()` caller hit it. Named sets in `inventory-types.ts`
  (`CONVERT_SHELF_LIFE_CLASSES` = prepared/produce/very_perishable/frozen;
  `PACKAGE_DURABLE_SHELF_LIFE_CLASSES` = pantry/fridge_long/fridge_short),
  mirrored into `axi/reference.ts`; CLI `assertConvertShelfLifeClass()` fails
  fast before the network call and `convert --help` lists the valid classes.
- Left `deriveEatBy`/`SHELF_LIFE_WINDOWS`/the `prepared` special case untouched
  (correct as-is); only *which classes convert accepts* changed.
- Verified independently before merge: `bun test packages/kitchen/src` →
  375 pass / 0 fail; `bun run build` green; CI on #153 green; scrub clean; guard
  inspected by hand.
- The three already-mis-classed batch items (oat jars/quinoa/eggs) were
  re-clocked operationally at report time (jars/quinoa → prepared 7/31, eggs →
  produce 8/3) — a data fix, out of this plan's code scope.

## Follow-ups

- **None.** `unknown` is intentionally not part of this guard (spec's rejected
  set is the three package-durable classes only).