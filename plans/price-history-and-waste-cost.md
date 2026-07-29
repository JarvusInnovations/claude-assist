---
status: done
depends: [kitchen-module, product-corrections, item-corrections]
specs:
  - specs/modules/kitchen.md
pr: 166
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
- **Store** — two new reads: `listProductPriceLines({ product_ulids, store?,
  limit? })` → flat `PriceLine[]` (line fields joined to the batch's
  `purchased_at`/`store`), newest first; and `listTossedCandidates(limit)`
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

- [x] `bun run build`, `bun run type-check:axi`, `bun run check:skills` green;
      `bun run test` green apart from one **pre-existing, environment-local**
      failure — see Notes.
- [x] Unit-price normalization across differing package sizes: one product
      bought at 12 / 16 / 42 oz yields a comparable `cents_per_100g` series
      (and the cheapest package is not the cheapest per gram), each point
      reporting the `unit_basis` it used.
- [x] The divisor precedence holds, including a count-stated size ("12 ct")
      falling THROUGH to a real net content rather than blocking it, and no
      resolvable size reading as null rather than a guess.
- [x] Weight and volume never cross-convert — a volume-stated package yields
      `cents_per_100ml` and a null `cents_per_100g`.
- [x] A multi-quantity line normalizes per PACKAGE (`price_cents / quantity`),
      not per line total.
- [x] Price history spans a product merge: after `POST /products/:ulid/merge`
      the survivor's history is the union of both records' purchases, and the
      retired loser still resolves but reads empty.
- [x] Partial-toss cost scales: a 0.25 toss costs a quarter of the package, and
      a counted pack tossed with 2 of 12 units left costs two twelfths.
- [x] The unknown-cost path reads as unknown: a manually-seeded item with no
      priced purchase reads `cost_cents: null` / `cost_basis: 'unknown'`, and
      the totals count it as unknown rather than adding `0`.
- [x] A mistakenly-`tossed` item that was merged away contributes no waste row,
      even though its stale `tossed …` note survives.
- [x] `GET /inventory/waste` is reached as a literal path rather than as an item
      ULID, and both reads validate their query strings.
- [x] AXI: `products prices` / `inventory waste` reach the new routes; reference
      and SKILL.md regenerated.

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

- **No migration, no stored prices, and no stored costs.** Every field of both
  reads is computed from rows that already exist, which is what makes a
  corrected receipt line or a re-scanned label correct every history that quotes
  it. The § Prices boundary was amended rather than broken: spend analysis,
  budgets, and period rollups stay outside the module; what moved inside is the
  *fact* read, because only the module knows how a line, a lexicon mapping, and
  a package size compose into a comparable unit price.
- **The divisor belongs to the point, not the product** — the decision the
  price read turns on. A product row holds one `net_content_g`, but package
  sizes genuinely differ between purchases and between stores, so normalizing
  every point by the product's current size would silently compare a 12 oz
  purchase against a 16 oz divisor. Resolution is per point, most-specific
  first, and the winning source is reported as `unit_basis` so two points that
  normalized differently say why.
- **A source that yields no mass does not consume the precedence.** A "12 ct"
  lexicon size resolves to neither grams nor millilitres, so resolution falls
  *through* it to the label's net content. Without that, a multipack whose
  lexicon size is a count could never normalize at all — the bug the
  fall-through test pins.
- **Unknown is null, and the total says how partial it is.** A product with no
  priced purchase costs `null` with basis `unknown`; the totals sum only known
  rows and report `cost_unknown_rows` beside them. A zero there would state that
  throwing food away cost nothing — the exact inversion of the read's purpose —
  and a total that quietly excluded unknown rows would look complete when it
  isn't. Both CLI surfaces say this in prose, and a test pins the wording,
  because the misreading is one glance away.
- **Cost attribution prefers the actual line.** For a receipt-born item, the
  line for its `(batch_ulid, product_ulid)` is what was *actually paid* for that
  package (matched by the line's representative `inventory_item_ulid` when it
  names this item, else by the batch, since a multi-quantity line fans out to N
  items and names only the earliest). The fallback is the nearest priced
  purchase — latest at or before `acquired_at`, else the earliest after — which
  also catches the item whose own line's price was unreadable. Every row reports
  `cost_basis` plus the line ULID and date, so the attribution is auditable per
  row rather than trusted.
- **Waste gates on structured state; only the AMOUNT comes from notes.** The
  named residue — a duplicate mistakenly marked `tossed`, then merged away,
  retracting its state but not its waste note — is handled by the *state* gate:
  the candidate query drops `dismissed` and `merged_into` rows, so the retracted
  toss contributes nothing and no second bookkeeping step exists to forget. What
  still comes from `notes` is the quantity discarded, because a full toss zeroes
  `on_hand_fraction` and a partial one decrements it — the schema keeps no
  column holding how much went in the bin. So the note is parsed, and a `tossed`
  item with no parseable note reads as an unknown amount rather than an assumed
  whole package.
- **One write-path change: a counted item's toss records its units.** A counted
  item's `on_hand_fraction` stays 1.0 through `finished-unit` decrements, so the
  fraction alone reads "the whole thing" for a pack with 2 of 12 left and would
  charge the full pack. A terminal toss now appends `tossed <amount> (<n>u)
  <date>` with the sealed remainder it discarded, and the cost divides the
  package price by `units_total`. A partial *fraction* toss of a counted item
  states no unit count, so none is invented.
- **Pre-existing test failure, not caused here.** `packages/kitchen`'s
  `src/services/mealbank.test.ts` fails locally in its `beforeEach` — the
  vendored `gitsheets` CLI errors against the /tmp fixture repo and the 5 s hook
  times out. It fails identically on a pristine `main` checkout and in an
  unrelated worktree with none of these changes, and CI is green on `main` with
  the now-gating test step, so it is a local environment artifact. Everything
  else is green: kitchen `521 pass / 1 fail` (that one), every other package
  `0 fail`, `bun run build` exit 0, `type-check:axi` clean, `check:skills`
  reports all four bundles and SKILL.mds up to date.
- The three unrelated CLI bundles were reverted after `build:skills` touched
  only their VERSION git-SHA stamp, so the diff stays on `kitchen-axi.mjs`.

## Follow-ups

- **Deferred — record tosses as structured rows.** A waste-event table (item,
  date, amount, units, retraction stamp) written by the toss path would retire
  the notes parse entirely and, unlike the state gate, would also let a
  *reconcile that resurrects* a mis-tossed item retract its waste — today that
  item's stale `tossed …` note is still counted, since its state is live again
  and the gate has nothing to catch. Deliberately out of scope here: this PR is
  derivation-only over existing rows, and a stored-event table needs its own
  migration, its own atomicity story alongside the item write, and a backfill
  decision for the tosses that only exist as notes.
- **Tracked here — no way to say "I tossed 2 of the 12".** `POST
  /inventory/:ulid/events` takes only a fraction, so a counted item's unit count
  reaches the record solely on a terminal toss (the sealed remainder). A partial
  unit toss is expressible today only as a fraction, which costs by fraction. A
  `units` field on the toss body is the fix, and it belongs with the item state
  model rather than with a read surface.
- **Deferred — structured measure capture on weighed lines** stays a follow-up,
  as § Prices already says. `parseMeasure` reads the printed measure out of
  `raw_text` (blessed there), and it will meet formats it does not know; the
  honest failure is a null `unit_basis`, never a guessed divisor. Worth
  revisiting only if that parse proves flaky across stores.
- **None for aggregates, by design.** No min/max/trend summary, no period
  rollup, no budget target — those are the personal-finance domain's business
  (§ Prices' boundary). A dated, normalized series is what an agent needs to see
  a trend; computing the trend for it would be the first spend dashboard.
