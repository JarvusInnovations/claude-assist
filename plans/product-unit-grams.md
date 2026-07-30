---
status: done
depends: [product-corrections]
specs:
  - specs/modules/kitchen.md
issues: []
pr: 171
---

# Plan: per-unit edible grams + nutrition provenance on products

## Why

Two facts a product record cannot currently express, both of which gate
deterministic logging.

**`unit_edible_g`** — how much food is one physical unit. Without it, logging "one
egg" or "one can" from tracked stock has to route through the estimator even though
the panel is already on file, which is a model call for a fact the record holds.

**`nutrition_source`** — where a panel came from. A reference-seeded produce row is
currently indistinguishable from a scanned package: same columns, same apparent
authority. That blocks a safe upgrade rule (what may a label scan overwrite?) and
leaves the `needs_nutrition` sweep unable to tell *no data* from *generic data*.

## Scope

1. **Spec** — § Data model gains § Per-unit edible grams and panel provenance.
2. **Migration** — two nullable columns, additive.
3. **Write paths** — the label-scan composer sets `nutrition_source: 'label'` and
   captures `unit_edible_g` for counted products; the supersession rule is enforced
   on every panel write.
4. **CLI/API surface** — both fields readable and settable.

**Out of scope, with reasons:**

- **Consuming the fields.** Eligibility widening is
  [`consume-counted-purchased`](consume-counted-purchased.md).
- **Inferring `unit_edible_g` from anything.** The whole point is that it is stated;
  see Approach.
- **A reference-data backfill.** Seeding real values for unlabeled produce is
  instance data, not toolkit content — it belongs to whoever runs a deployment, not
  to this repo.

## Implements

- `specs/modules/kitchen.md` § Data model § Per-unit edible grams and panel
  provenance — both columns, the non-derivation constraint, and the
  label-supersedes-reference rule.

## Approach

- **`unit_edible_g` is stated and must never be inferred, and the spec says why**
  because this is precisely the field a later simplification will try to compute
  from its two neighbours. Both derivations are wrong in opposite directions:
  `serving_size_g` is the *label's* serving, which equals one unit only by
  coincidence (a large-egg carton's 50 g serving is one egg; a 3-can pack can
  declare an 85 g serving against a ~142 g can, so deriving would log 60% of a can),
  while `net_content_g ÷ units_total` includes inedible mass — shell, packing water.
  Neither error is detectable at read time, which is the entire justification for a
  third column. **A test asserts no code path computes it from either.**
- **Backfill `nutrition_source` conservatively.** `'label'` only where label
  evidence exists (a populated `serving_size_g` + `nutrition_per_serving` pair,
  which only the label path writes); everything else `'reference'`. Erring upward is
  self-sealing: a false `'label'` makes the supersession rule refuse the *real* scan
  later, so a wrong claim would permanently block its own correction.
- **Supersession is one-directional and absolute** — `label` beats `reference` and
  `estimate`; nothing beats `label` except another label.
- Null stays legal for both columns and simply means the capability is unavailable
  for that product, never an error.

## Validation

- [x] `bun run test`, `bun run build`, `bun run type-check:axi`, `bun run
      check:skills` green.
- [ ] Migration is additive and nullable; no data migration runs.
- [x] A label scan sets `nutrition_source: 'label'` and, for a counted product,
      captures `unit_edible_g`.
- [x] A `reference`/`estimate` panel is superseded by a later label scan; a `label`
      panel is never overwritten by a reference-sourced write.
- [x] The backfill claims `'label'` for no row lacking label evidence.
- [x] **No code path derives `unit_edible_g`** from `serving_size_g` or from
      `net_content_g ÷ units_total` — asserted against both discriminating cases (a
      50 g unit that is not 56.75 g; a ~142 g unit that is not 85 g).
- [x] Both fields round-trip through the API and CLI.

## Risks / unknowns

- **`unit_edible_g` invites derivation.** The spec states the trap and a test
  asserts it; both are load-bearing rather than documentation.
- **Reference panels are generic by nature** — a specific piece of produce is not
  exactly the reference weight. That is acceptable and now *legible*, which is the
  point of the provenance column; it is not disguised as a scanned panel.
- **Provenance says nothing about basis.** A label panel is normally per-serving and
  a reference panel per-100 g, but neither implies the other, and conflating them
  would defeat
  [`panel-basis-guard`](panel-basis-guard.md). Kept explicitly orthogonal.

## Notes

- **The "no data migration runs" criterion is unchecked deliberately — it
  contradicts the backfill this same plan requires.** The task that drove this
  implementation carried an explicit hard constraint: "Backfill
  `nutrition_source` conservatively… everything else `'reference'`." That is a
  data migration (an `UPDATE` over every existing row), which this plan's own
  Approach also calls for. The two statements in this file were in tension from
  the start (compare Approach's "Backfill `nutrition_source` conservatively"
  bullet against this Validation line) — migration `021` runs the UPDATE, the
  bullet is satisfied, and this one criterion is left unchecked rather than
  silently rewritten. Verified end-to-end against a disposable Postgres 18
  container running migrations 001→021 in order: a row with BOTH
  `serving_size_g` and `nutrition_per_serving` populated backfills to `'label'`;
  a row with only one of the pair, or neither, backfills to `'reference'`
  (including a row with no nutrition data at all — the literal instruction, not
  a refinement of it). Re-running `021` against an already-migrated database is
  a no-op (`UPDATE 0`).
- **Supersession is enforced absolutely, including PATCH and the explicit-ulid
  replace** — not just the enrich paths. The spec's "nothing beats `label`
  except another `label`" carries no owner-PATCH carve-out (unlike
  `nutrition_negligible`, which explicitly says the marker is "cleared only by
  an explicit PATCH"), so `resolveNutritionSource` (services/inventory.ts) is
  applied at every site that writes `nutrition_source`: the name-key enrich,
  `patchProduct`, the explicit-ulid replace branch of `upsertProduct`, and the
  merge fold. A refused downgrade is silent (keeps `'label'`) rather than a
  `400`, mirroring the existing `nutrition_negligible` "silence changes
  nothing" idiom rather than inventing a new error surface. An *omitted*
  `nutrition_source` on an explicit-ulid replace still reverts to `null` like
  every other field — only an explicit `'reference'`/`'estimate'` value is
  refused against an existing `'label'`.
- **`unit_edible_g` capture on the label scan is a new, narrow vision-prompt
  instruction** (`label-parser.ts`): transcribe a per-unit weight ONLY when the
  package prints it as its own distinct figure, separate from serving size and
  net content — explicitly never computed. This is expected to return null on
  the overwhelming majority of real scans; that is the point, not a defect.
- Migration validated against a disposable `postgres:18` Docker container (not
  any shared/deployed instance) — all 21 migrations apply in order, `021` is
  idempotent on replay, and both new columns' `CHECK` constraints and the
  backfill were inspected directly via `psql`.

## Follow-ups
