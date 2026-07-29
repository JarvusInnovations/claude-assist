---
status: planned
depends: [kitchen-module, added-sugar-panel]
specs:
  - specs/modules/kitchen.md
issues: [159]
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

- [ ] `bun run test`, `bun run build`, `bun run type-check:axi`,
      `bun run check:skills` all green.
- [ ] A partial `PATCH` leaves unspecified fields untouched, and a per-field
      panel patch fills one field without erasing the other eight.
- [ ] `POST` with an explicit `ulid` answers `201` on create and `200` on
      replace, same ULID both times.
- [ ] **Regression on the silent strip**: a `POST` carrying an existing product's
      `ulid` never mints a second record — it is honored (or refused), never
      ignored-and-201'd.
- [ ] A name-key `POST` enriches rather than replacing: a bare `{name}` re-post
      does not erase an existing nutrition panel.
- [ ] Merge relinks inventory items, lexicon lines, and batch lines to the
      survivor, and the loser ends archived with `merged_into` set.
- [ ] A `nutrition_negligible` product clears `needs_nutrition` on its linked
      item with an empty panel, and its effective panel reads zeros rather than
      nulls.
- [ ] AXI: `products update` / `products merge` reach the new routes; reference
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

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
