---
status: in-progress
depends: [stated-weight-consume, packed-sources-follow-weights]
specs:
  - specs/modules/kitchen.md
issues: [215]
pr: 221
---

# Plan: a meal consumes MANY items — `entry_consumptions` replaces the single link column

## Why

An eaten worksheet decrements at most ONE of its components. Everything else is
refused.

`kitchen.entries.inventory_item_ulid` is a single column, so one journal entry can
name exactly one inventory item. Cook mode's `applyConsumes` calls the
stated-consumption path once per component binding; the first binding takes the
column, and every later one hits `consumeStatedAmount`'s "already linked to a
different item" guard and is refused as a conflict.

That guard is right for the shape it was written against — a second link on a
one-tap consume would double-count the same meal — and wrong the moment a meal
has more than one tracked component, which is the ordinary case a worksheet
exists to describe.

Observed live: a six-component `--cook eaten` sheet, all six bound, submitted
normally. Two components decremented, four refused. The refusals were surfaced on
the entry note exactly as § An unapplied decrement is VISIBLE, never silent
requires, so nothing was hidden — but the practical ledger effect is roughly one
component per meal, much closer to the pre-feature "nothing decrements" state
than to fixed. This has been the behaviour since eaten-decrements shipped.

The fix is the model, not the guard: **the idempotency key was always meant to be
`(entry, item)`**, and a single column cannot hold a set.

## Scope

**In:**

- New table `kitchen.entry_consumptions` (`entry_ulid`, `item_ulid`, `amount`,
  `amount_kind`, `created_at`; PK `(entry_ulid, item_ulid)`), backfilled from the
  existing column. One migration.
- `ConsumeStore.linkConsumption` re-keyed on the pair: the join-row insert
  becomes the replay guard, still committing with the depletion in one
  transaction.
- `ConsumeStore.consume` writes its join row inside its existing transaction.
- `consumeStatedAmount`'s pre-check re-keyed on the pair; the
  now-unreachable `StatedConsumeConflictError` (and its `409`) removed.
- Depletion-matcher links and item-merge relinks carried onto the join table,
  including the relink collision a merge can produce.
- Memory stores kept behaviourally identical to the SQL ones.

**Out:**

- **`entries.inventory_item_ulid` is not dropped** — see § Approach.
- **Counted (`--component-unit`) bindings still do not link.** Cook mode
  depletes those through `finishUnit`, an item-side event with no entry
  parameter, so a counted component moves stock without recording which entry
  moved it and without a replay guard. Real, pre-existing, and a wider change
  than this one (it needs an entry-aware counted verb); tracked in § Follow-ups.
- **The bare depletion path (#174).** `POST /inventory/:ulid/consumed` with no
  `entry_ulid` remains unguarded — see § Notes for why the join table cannot
  close it.
- Any change to matching, the depletion step, or worksheet authoring.

## Implements

- `specs/modules/kitchen.md` § Data model (`kitchen.entry_consumptions`;
  `entries.inventory_item_ulid` restated as derived)
- `specs/modules/kitchen.md` § Stated-weight consumption ("One entry may deplete
  MANY items, and the idempotency key is the pair")
- `specs/modules/kitchen.md` § Eaten sheets decrement their sources § Every bound
  component decrements, not just the first
- `specs/modules/kitchen.md` § Depletion matcher (one-shot *by matching*;
  fan-out belongs to callers that state their components)
- `specs/modules/kitchen.md` § Item corrections (relink collapses on collision)
- `specs/modules/kitchen.md` § API `POST /inventory/:ulid/consumed`

## Approach

1. **Migration `024-kitchen-entry-consumptions.sql`** — create the table, index
   it by `item_ulid` (the merge/relink direction), and backfill one row per
   non-null `entries.inventory_item_ulid` with a NULL amount. A backfilled row
   states exactly what the old column stated — that this entry depleted this item
   — and nothing more; inventing an amount for it would be a fabricated ledger
   number. `entry_ulid` carries an FK with `ON DELETE CASCADE`, which reproduces
   what the column did for free: deleting an entry retracted its depletion claim
   because the claim lived on the row.

2. **Keep `entries.inventory_item_ulid` as a derived convenience.** Deliberate,
   and the issue's own suggestion. It is in the `Entry` wire shape the app and
   CLI read; it is what `consume()` sets in the SAME insert (a spec-load-bearing
   atomicity property that survives untouched if the column does); and it is the
   exactly-right key for the depletion matcher's one question — "has this entry
   depleted anything at all?" Dropping it would churn the wire contract, the
   matcher, four store implementations, and a dozen test assertions to remove a
   column whose remaining job is single-valued anyway. It now holds the FIRST
   item linked and is documented as derived; `entry_consumptions` is
   authoritative.

3. **`linkConsumption` keyed on the pair.** Keep the `SELECT … FOR UPDATE` on the
   entry row — it still serialises concurrent links for one entry and still
   proves the entry exists — then `INSERT … ON CONFLICT (entry_ulid, item_ulid)
   DO NOTHING`. Zero rows back means replay: read the item back unchanged and
   return `linked: false`, exactly as the entry-keyed version did. One row back
   means a fresh component: fill the derived column if it is still null, then
   deplete. Atomicity is unchanged — one `sql.begin`, both writes or neither.

4. **`consumeStatedAmount` pre-check** asks `peekConsumption(entry, item)`
   instead of reading the entry's column. The "already linked to a different
   item" branch has no replacement because it names a case that is no longer an
   error, so `StatedConsumeConflictError` and its `409` mapping go with it.

5. **Relink with collapse.** An item merge can leave one entry holding rows for
   both the loser and the survivor. Repointing blindly violates the PK, so the
   colliding pair collapses first: amounts add when both are known and share a
   kind, and the survivor's row is kept as-is otherwise (a fraction and a unit
   count cannot be added honestly). Then the non-colliding rows are repointed.
   Three statements in one transaction, because data-modifying CTEs would all see
   the pre-delete snapshot and re-collide.

6. **Amounts are what was APPLIED**, in the item's own unit model — `'fraction'`
   or `'units'` — not what was requested. A stated 50 g against a 500 g package
   records `0.1 fraction`, because that is the movement the ledger actually made;
   the grams stay in the item's provenance note where they already are.

7. **Memory stores mirror all of it** — a `consumptions` map on
   `MemoryEntryStore` with the same collapse rule and the same
   delete-cascades-links behaviour, since the test suite runs against them.

## Validation

- `bun test` before/after with the pre-existing UTC-sandbox timezone failures
  confirmed identical (set and count), and the total test count strictly up.
- New tests: a multi-component link (three items, one entry, all three deplete);
  per-pair replay (same pair twice → one decrement, `linked: false`); the
  end-to-end cook-mode case — a six-binding eaten sheet decrements six items and
  reports zero unapplied; merge collapse (an entry linked to both loser and
  survivor ends with one row and the summed amount); entry delete removes its
  consumption rows.
- The removed `409` conflict test is replaced by its inverse: two different items
  under one entry both link.
- `bun run build`, `bun run build:cli` (the `consumed` help text changes), and
  `bun run check:skills`.

## Risks / unknowns

- **The migration is the only irreversible-ish step.** It is additive — a new
  table plus a backfill `SELECT`; nothing existing is altered or dropped — so
  reverting is `DROP TABLE`. A verified pre-migration snapshot exists
  independently.
- **The derived column can now drift** from the join table if a future writer
  updates one and not the other. Mitigated by routing every writer through the
  two store methods that update both, and by the column's only remaining reader
  (the matcher guard) being insensitive to *which* item it names.
- **Merge collapse loses one amount** when the two rows disagree on kind. That is
  a deliberate refusal to add unlike quantities, and it affects a row whose
  amount is provenance, not ledger state — the item's on-hand numbers are
  unaffected either way.
- **Contention**: `FOR UPDATE` on the entry row now serialises the components of
  one meal rather than one call. Cook mode applies bindings sequentially anyway,
  so this changes nothing in practice.

## Notes

- **#174 is NOT closed by this**, and the plan does not claim it. #174 is the
  bare `POST /inventory/:ulid/consumed` with no `entry_ulid`: a retry
  double-decrements because there is no key at all. A `(entry, item)` key cannot
  guard a call that names no entry — with no client-supplied identity, a genuine
  second helping and a retried first one are indistinguishable by construction.
  What DOES change is exposure: cook mode, the dominant producer of stated
  consumptions, always supplies `entry_ulid`, and every one of its bindings is
  now guarded rather than just the first. Closing #174 needs what its own author
  proposed — an optional client-supplied ULID naming the *depletion event* —
  which is an additive request-schema change on a path this plan does not
  otherwise touch, and is better done on its own than folded into a data-model
  migration.

## Follow-ups

- **#174** — opt-in idempotency ULID for the entry-less depletion, matching
  `convert`'s `derived.ulid` precedent.
- **Counted components link nothing.** `--component-unit` bindings deplete
  through `finishUnit`, which takes no entry, so those decrements land in the
  ledger with no provenance and no replay guard while gram-bound components now
  have both. Wants an entry-aware counted consumption verb.
