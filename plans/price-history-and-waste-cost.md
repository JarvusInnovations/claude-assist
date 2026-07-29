---
status: in-progress
depends: [kitchen-module, product-corrections, item-corrections]
specs:
  - specs/modules/kitchen.md
---

# Plan: Price history reads + waste costing

## Why

Receipt intake has transcribed every line's printed price since migration `011`
(`purchase_batch_lines.price_cents`, `purchase_batches.total_cents`), and the
lexicon links most lines to a product — so the module already holds a
per-product, per-store purchase history. Nothing can read it. `GET
/receipts/:ulid` shows one batch's lines; there is no path from a *product* to
what it has cost over time, and no code anywhere divides a line price by
anything.

The second gap is worse, because it silently reports a wrong number rather than
none. A toss records an amount (in the item's `notes`) and a terminal state, but
no cost. "Waste trends toward zero" is one of the module's stated goals
(§ Phase 2 preamble) and the only thing measurable today is a count of
incidents — which ranks a tossed bag of greens equal to a tossed roast. Waste
without a price attached is a metric nobody steers by.

The two ship together because the second is built entirely on the first: waste
cost is the price history evaluated at one item.

## Scope

Two read surfaces and one write-path addition. Semantics are settled in
`specs/modules/kitchen.md` § Price history and § Waste costing; implementation
does not re-litigate them.

1. **`GET /products/:ulid/prices?store&limit`** — the product's recorded
   purchases, newest first, each with the store, the printed line price, the
   per-package price (`price_cents / quantity`), and a per-point unit
   normalization to `cents_per_100g` / `cents_per_100ml` with the `unit_basis`
   that produced it. Pure read-time derivation over
   `purchase_batch_lines` × `purchase_batches` × `receipt_lexicon` × products.
2. **`GET /inventory/waste?since&until&limit`** — every recorded toss with the
   amount discarded and its attributed cost, plus totals that separate known
   cost from unknown-cost row count. Cost attribution prefers the item's own
   batch line, falls back to the nearest priced purchase of the product, and
   reads `unknown` (null, never `0`) when the product has no price on file.
3. **The counted-item toss note gains its unit count** — `tossed <amount>
   (<n>u) <date>`. The only write-path change, and it exists because
   `on_hand_fraction` does not track a counted item's unit count, so the
   fraction alone would charge a full pack for a nearly-empty one.

Plus the AXI surface (`products prices`, `inventory waste`) with the reference
and SKILL.md regenerated. **No migration** — every field is derived from
existing columns.

## Implements

- `specs/modules/kitchen.md` § Price history — the read, the per-point divisor
  precedence, the merge-unions-history property, and the no-stored-prices
  boundary restatement.
- `specs/modules/kitchen.md` § Waste costing — the attribution order, partial
  scaling, unknown-cost-is-null, and the structured-state gate.
- `specs/modules/kitchen.md` § API — `GET /products/:ulid/prices`,
  `GET /inventory/waste`; § JSON shapes — `PricePoint`, `WasteRow`.
- `specs/modules/kitchen.md` § Inventory state machine — the counted-item toss
  note's unit count.

## Approach

- **`src/inventory-pricing.ts`** — the pure core, no store, no I/O:
  `parseMeasure` (a printed size string or receipt line → `{value, unit}`),
  `measureToUnits` (→ grams **or** millilitres, reusing the label scan's
  conversion tables via `convertNetContent`), `resolveUnitBasis` (the four-step
  precedence), `pricePoint` (one line + batch + lexicon + product → a
  `PricePoint`), `parseTossNotes` (notes → toss records), and `wasteCost`
  (a toss record + a resolved price → `{cost_cents, cost_basis}`). Everything
  testable without a store, which is where the interesting cases live.
- **Store** — one new read: `listPriceLines({ product_ulids, store?, limit? })`
  → flat `ProductPriceLine[]` (line fields joined to the batch's
  `purchased_at`/`store`), newest first; and `listTossedCandidates({ limit })`
  → items whose notes carry a toss line, excluding `dismissed` and
  `merged_into` rows in SQL. Memory store mirrors both.
- **Service** — `InventoryPipeline.priceHistory(productUlid, opts)` and
  `wasteReport(opts)`. `wasteReport` fetches candidates, parses notes, filters
  the date window, resolves each item's price (its own batch line first, then
  the product's nearest priced line), and sorts newest-toss-first before
  capping.
- **Routes** — `GET /kitchen/products/:ulid/prices` and
  `GET /kitchen/inventory/waste`, the latter registered before
  `/kitchen/inventory/:ulid` (find-my-way prefers literals, same as
  `/questions`).
- **AXI** — `products prices <ulid>`, `inventory waste`; TOON row schemas that
  render cents as cents and unknowns as null, `help[]` lines that say what an
  unknown cost means so an agent does not read it as free.

## Validation

- [ ] `bun run test`, `bun run build`, `bun run type-check:axi`,
      `bun run check:skills` all green.
- [ ] Unit-price normalization across differing package sizes: the same product
      bought at 12 oz and 16 oz normalizes to different `cents_per_100g` from
      the same-looking prices, and each point reports the `unit_basis` it used.
- [ ] Weight and volume never cross-convert — a volume-stated package yields
      `cents_per_100ml` and a null `cents_per_100g`.
- [ ] Price history spans a product merge: after `POST /products/:ulid/merge`
      the survivor's history is the union of both records' purchases.
- [ ] Partial-toss cost scales: a 0.25 toss costs a quarter of the package, and
      a counted item's 2-of-12 toss costs two twelfths.
- [ ] The unknown-cost path reads as unknown: a manually-seeded item with no
      priced purchase reads `cost_cents: null` / `cost_basis: 'unknown'`, and
      the totals count it as unknown rather than adding `0`.
- [ ] A mistakenly-`tossed` item that was merged away contributes no waste row.

## Risks / unknowns

- **The toss amount lives in `notes`.** It is the only record of a waste
  quantity in the schema, so the read parses it. The named residue (a merged-away
  loser's stale waste note) is handled structurally instead — the read excludes
  `dismissed`/`merged_into` items — but a *reconcile* that resurrects a
  mis-tossed item still leaves its note behind and will be counted. A structured
  waste-event row is the durable fix and is deliberately out of scope.
- **Package size is a string.** `parseMeasure` will meet formats it does not
  know; the honest failure is a null `unit_basis` and null normalized prices,
  never a guessed divisor.
- **A counted item's `on_hand_fraction` is not its unit count.** Pre-existing
  toss notes carry no unit count, so historical counted-item tosses cost by
  fraction (usually a whole pack). Only new tosses record units.

## Notes

Populated at closeout.

## Follow-ups

Populated at closeout.
