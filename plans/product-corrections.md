---
status: done
depends: [kitchen-module, added-sugar-panel]
specs:
  - specs/modules/kitchen.md
issues: [159]
pr: 160
---

# Plan: Product corrections — upsert, patch, merge, and the negligible marker

## Why

`POST /kitchen/products` is create-only. `InventoryService.createProduct`
unconditionally calls `insertProduct({ ulid: generateUlid(), ... })`, there is no
`PATCH`/`PUT`/`DELETE` route (all 404 on a live instance), and
`InventoryStore.updateProduct(ulid, patch)` — which already exists in the store
interface, already implemented on both stores — is exposed by nothing.

So a product's nutrition can be set at creation and never afterwards. Posting the
same product again mints a duplicate and leaves the original as it was.

Worse than merely absent: `PRODUCT_BODY_SCHEMA` is `required: ['name']`,
`additionalProperties: false`, with **no `ulid` property**. A caller supplying an
existing product's ULID has it silently stripped, gets a fresh ULID, and is
answered **`201`** — a write that did not do what was asked, reporting success,
and indistinguishable from the enrichment the caller wanted. Same family as the
SPA-shell-instead-of-404 defect fixed earlier.

Downstream, `needs_nutrition` is computed from the linked product's
`nutrition_per_100g` completeness, so for any product born without a panel the
flag is permanently unresolvable through the API. One category can't resolve it
at all: US spice jars carry **no Nutrition Facts panel**, because FDA exempts
foods with insignificant amounts of every nutrient. A normal spice rack accrues
items flagged forever, and a flag that can never be cleared teaches the reader to
ignore the flag — including on the items that *are* actionable. Widening the
panel (the ninth field, PR #158) made this sharply worse by retroactively
flagging every pre-existing product.

## Scope

Four parts. Semantics are settled in `specs/modules/kitchen.md` § Product
corrections and § Nutritionally negligible products; implementation does not
re-litigate them.

1. **`PATCH /kitchen/products/:ulid`** — expose `updateProduct`. Partial: only
   supplied keys change, explicit `null` clears, the two nutrition panels merge
   per-field. `name` is patchable (identity is the ULID), with a `409` guard on a
   rename that collides with a live product's normalized name.
2. **`POST /kitchen/products` becomes a real upsert.** Optional `ulid` in the
   schema: create-or-replace that exact record (`201`/`200`). Without a `ulid`,
   the normalized name is the key — no match creates, one match **enriches** in
   place, several `409` naming the candidates. The silent strip stops either way.
3. **Merge + archive.** `POST /kitchen/products/:ulid/merge {into}` enriches the
   survivor from the loser, relinks `inventory_items` / `receipt_lexicon` /
   `purchase_batch_lines`, then archives the loser with `merged_into` set.
   `DELETE /kitchen/products/:ulid` archives alone. Neither ever deletes a row —
   items and lexicon lines point at products and must keep resolving.
4. **`nutrition_negligible`.** New boolean column. Suppresses `needs_nutrition`
   at the item view, and asserts an all-zero effective panel at read time (never
   written into storage). The realistic-serving approximation is accepted with
   no quantity threshold — reasoning in the spec.

Plus: migration `017`, both stores moving in lockstep (pg + memory), and the AXI
surface (`products update`, `products merge`, `products archive`, `--negligible`,
`--ulid` on `add`) with the reference and SKILL.md regenerated.

## Implements

- `specs/modules/kitchen.md` § Product corrections — `POST /products` upsert,
  `PATCH /products/:ulid`, `POST /products/:ulid/merge`,
  `DELETE /products/:ulid`, and the local principles.
- `specs/modules/kitchen.md` § Nutritionally negligible products — the marker's
  two effects and the no-threshold decision.
- `specs/modules/kitchen.md` § Data requirements / Data model — the three new
  `kitchen.products` columns.

## Approach

- **Migration `017-kitchen-product-corrections.sql`** — additive
  `ADD COLUMN IF NOT EXISTS` for `nutrition_negligible BOOLEAN NOT NULL DEFAULT
  FALSE`, `archived_at TIMESTAMPTZ`, `merged_into CHAR(26)`; a partial index on
  `(name) WHERE archived_at IS NULL` for the live-name key lookup, mirroring
  `015`'s recipe index.
- **Types** — the three fields onto `ProductRecord`; `nutrition_negligible` onto
  `ProductInput` / `NewProduct` / `ProductPatch`. `rowToProduct` maps them.
- **Store** — `listProducts` filters archived; `getProduct` /
  `getProductsByUlids` deliberately do not (history resolves forever). New:
  `findLiveProductsByNormalizedName`, `archiveProduct(ulid, mergedInto?)`,
  `relinkProductReferences(from, to)` returning per-table counts. Memory store
  mirrors each.
- **Service** — `upsertProduct` (the POST branch logic), `patchProduct`,
  `mergeProducts`, `archiveProduct`; `ProductNameConflictError` and
  `ProductMergeConflictError` for the 409s. `enrichProduct` is reused for both
  the name-key hit and the merge's survivor enrichment rather than duplicating
  the precedence table — it is already the documented one.
- **`needsNutrition`** short-circuits on the flag. `productPanel(product)`
  resolves the effective panel (stored panel, else all-zeros when marked, else
  null) as the single place the zero assertion lives.
- **Routes** — schema `PRODUCT_BODY_SCHEMA` gains `ulid` + the raw-serving
  fields it was missing; a separate `PRODUCT_PATCH_SCHEMA` with `minProperties:
  1` and nullable everything.

## Validation

- [x] `bun run test`, `bun run build`, `bun run type-check:axi`,
      `bun run check:skills` all green.
- [x] A partial `PATCH` leaves unspecified fields untouched, and a per-field
      panel patch fills one field without erasing the other eight.
- [x] `POST` with an explicit `ulid` answers `201` on create and `200` on
      replace, same ULID both times.
- [x] **Regression on the silent strip**: a `POST` carrying an existing product's
      `ulid` never mints a second record — it is honored (or refused), never
      ignored-and-201'd.
- [x] A name-key `POST` enriches rather than replacing: a bare `{name}` re-post
      does not erase an existing nutrition panel.
- [x] Merge relinks inventory items, lexicon lines, and batch lines to the
      survivor, and the loser ends archived with `merged_into` set.
- [x] A `nutrition_negligible` product clears `needs_nutrition` on its linked
      item with an empty panel, and its effective panel reads zeros rather than
      nulls.
- [x] AXI: `products update` / `products merge` reach the new routes; reference
      and SKILL.md regenerated.

## Risks / unknowns

- **Enrich-vs-replace on the name key is the subtle one.** Replacing would let a
  receipt seed carrying `{name, shelf_life_class}` erase a scanned panel. The
  enrich precedence is `enrichProduct`'s existing one; the test that matters is
  the bare-`{name}` re-post preserving nutrition.
- **`listProducts` now filters archived, and it has two callers** — the route and
  the label path's `upsertProductByName`. Excluding archived rows from the label
  path's name match is correct (a retired duplicate must not be re-matched), but
  it is a behavior change to that path, not only to the new one.
- **Merge chains and cycles.** Refusing to merge into an archived survivor keeps
  the graph one level deep; following chains would invite a cycle. The refusal
  names the survivor's `merged_into` so the caller retargets.
- **The zero assertion is technically wrong at large quantities.** Accepted and
  argued in the spec; the risk is that a future reader hits it and "fixes" it
  into a quantity-conditional flag, which is why the reasoning is written down
  rather than left implicit.

## Notes

- **The name key enriches; only an explicit `ulid` replaces.** This is the one
  deliberate divergence from `POST /recipes`, and it was the sharpest decision
  here. A recipe is its name plus its components, so a push states the whole
  thing and overwriting is right. A product is a many-field accretion built by
  several independent writers, and a replacing name key would let a receipt seed
  carrying `{name, shelf_life_class}` erase a scanned panel — a write destroying
  data it never mentioned. The pinning test is the bare-`{name}` re-post
  preserving nutrition.
- **An explicit `ulid` bypasses the name checks, and the rename guard fires only
  on a name that *changes* into a twin's.** Both fell out of implementation and
  were amended into the spec rather than left in code. The first: the escape hatch
  out of a name-key ambiguity is "pass the ulid of the one you mean", so
  re-checking the name there would block it with the very collision it resolves.
  The second: without it, patching any other field alongside an unchanged `name`
  would 409 against the product itself.
- **The negligible marker asserts zeros, and the zeros are derived, never
  stored.** `productPanel()` is the single place that resolution lives, and it
  merges per-field rather than spreading — a stored panel's explicit nulls are
  gaps the marker fills, so a number someone actually read still wins. Keeping
  `nutrition_per_100g` null in storage means the assertion is one reversible
  boolean and a real panel found later supersedes it without anyone having to
  tell asserted zeros from scanned ones.
- **No quantity threshold on the marker, argued in the spec rather than assumed.**
  The flag is a property of the product, read at points that hold no quantity, so
  a threshold would have no argument at the moment it needed one; a
  context-dependent flag would also reintroduce the two-reads-disagree failure the
  rest of the section removes. Written down explicitly because the next reader
  will notice 100 g of paprika is ~282 kcal and be tempted to "fix" it.
- **Merge chains stop at one level.** Merging *into* an archived survivor is a
  409 naming its own `merged_into`, rather than following the chain — chasing
  pointers invites a cycle, and retargeting is a one-line fix for the caller.
- **`listProducts` now filters archived rows**, which changes the label
  pipeline's `upsertProductByName` match path too (a retired duplicate must not
  be re-matched). Intended, but it is a second caller, not only the new route.
- **Migration `017-kitchen-product-corrections.sql` has not been run against any
  database** — additive `ADD COLUMN IF NOT EXISTS`, applies on next boot. The
  `merged_into` CHECK rides a `DO $$ … EXCEPTION WHEN duplicate_object` block,
  since a CHECK cannot be added idempotently alongside `ADD COLUMN IF NOT
  EXISTS`.
- Verified before opening the PR: `bun run test` exit 0 (every package `0 fail`;
  kitchen 451 pass), `bun run build` exit 0 (14/14 packages), `bun run
  type-check:axi` clean, `bun run check:skills` reports all four bundles and
  SKILL.mds up to date. Full-diff scrub scan clean.
- The three unrelated CLI bundles were reverted after `build:skills` touched only
  their VERSION git-SHA stamp, so the diff stays on `kitchen-axi.mjs`.

## Follow-ups

- **None for existing duplicates or unmarked products — by design.** Backfilling
  was out of scope: marking `nutrition_negligible` is a deliberate per-product
  assertion nothing in code can honestly infer, and choosing which of two
  real-world duplicates survives is a judgment about the instance's own data.
  Both are now one CLI call each (`products update <ulid> --negligible`,
  `products merge <dupe> --into <survivor>`), which is the point.
- **Tracked here, not fixed — one `pushed`/`promoted`-style ambiguity remains
  open for products.** `POST /products` with an explicit `ulid` may create a
  second live product whose normalized name matches an existing one, because the
  explicit key deliberately bypasses the name check. That is the intended escape
  hatch, but it means the ambiguous-name `409` on the name-key branch can be
  reached by a caller's own doing. The remedy is the merge path, and the error
  says so. Collapsing names across products entirely is a broader question than
  closing the no-update hole.
- **Deferred — the label pipeline's `upsertProductByName` still takes the first
  case-insensitive match** rather than 409ing on ambiguity like the route does. It
  can't refuse: it runs from a photo resolve, where there is no caller to hand a
  disambiguating `ulid` to. Left as-is deliberately; it now at least never matches
  an archived duplicate.
