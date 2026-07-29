---
status: done
depends: [kitchen-module, convert-sourceless]
specs:
  - specs/modules/kitchen.md
issues: [156]
pr: 164
---

# Plan: `convert` is atomic — a failed prep transform loses no food

## Why

`InventoryPipeline.convert` performed its writes in sequence with no enclosing
transaction: each source's decrement, then the derived item's insert, then the
derivation's insert. A failure between the first and second left the **sources
spent with no derived item** — the inputs gone from the ledger, the output never
created.

That is the damaging direction. A prep transform is precisely where several
tracked inputs are spent at once, and this failure makes the ledger claim
**less** stock than reality. Under-reporting is the direction nothing downstream
flags: eat-first just quietly stops offering food that is still in the fridge, no
error, no `409`, no question queued. It surfaces weeks later as unexplained
drift, by which point the transform that caused it is unrecoverable.

The second window (a derived item with no derivation row) is quieter but
corrupting in its own way: it breaks cost attribution, and because
`derived_from.recipe_ulid` is the ONLY macro-inheritance channel, an item that
loses its provenance silently becomes consume-ineligible — the one-tap path
refuses food it should have known the macros for.

The gap was known. It was raised in the review of the PR that introduced
`convert` and left only as a code comment inside `consume-store.ts`, pointing at
a merged PR — a reference that reads like a tracking link but tracks nothing. It
was filed as #156 so it stopped depending on someone reading that comment.

## Scope

1. **`InventoryStore.applyConversion(write)`** — one store method applying all
   three write phases as one unit, `sql.begin` in `PgInventoryStore`,
   snapshot-and-restore in `MemoryInventoryStore`.
2. **Split `convert` into a plan phase and a write phase.** Validation and
   per-source decrement *computation* move ahead of every write
   (`applyConversionDecrement` → the pure `planConversionDecrement`), so a
   rejected request never opens a transaction and no source is spent on a
   conversion that a later source was going to fail.
3. **Spec** — § Conversions gains an § Atomicity subsection stating the
   guarantee, and § Consume from inventory § Atomicity stops describing convert's
   gap as outstanding.

**Out of scope, with reasons:**

- **Retry deduplication.** Decided, not deferred by omission — see Approach.
  `convert` takes no idempotency key and continues not to.
- **A separate `convert-store.ts` + memory twin**, the literal shape #156
  proposes. Argued down under Approach: convert turned out to be single-store.
- **`consume`'s atomicity**, already solved (`ConsumeStore.consume`) and only
  referenced here.
- **Concurrency between two conversions spending the same source.** The
  transaction makes each attempt whole; it does not add row locking, so two
  simultaneous conversions off one pack can still interleave their read-plan-write
  cycles. Under Risks.

## Implements

- `specs/modules/kitchen.md` § Conversions § Atomicity — the all-or-nothing
  guarantee, the store-level mechanism, why under-reporting is the dangerous
  direction, validation-precedes-writes, and the not-idempotent-by-design rule.
- `specs/modules/kitchen.md` § Consume from inventory § Atomicity — amended: the
  guarantee is now module-wide rather than one path's, and convert's gap is
  closed rather than "deliberately NOT repeated here".
- `specs/modules/kitchen.md` § API `POST /inventory/convert` — atomic, and
  explicitly not idempotent.

## Approach

- **It is a single-store transaction, so no second store interface.** #156
  proposes a `convert-store.ts` + memory twin mirroring `consume-store.ts`, on the
  assumption that the same seam is crossed. It isn't: `consume` writes
  `kitchen.entries` (owned by `EntryStore`) *and* `kitchen.inventory_items`, which
  is the whole reason a third interface exists to straddle them. Every table a
  conversion writes — `kitchen.inventory_items`,
  `kitchen.inventory_derivations` — is owned by `InventoryStore`. So this lands
  as one more method on that interface, `applyConversion`, and gets its memory
  analogue the way every other store method does. That also removes an entire
  failure mode the injected-store shape carries: `consumeStore` is optional and
  `consume()` answers `503 ConsumeNotConfiguredError` when it's unwired, whereas
  `store` is a positional constructor argument that cannot be absent — so
  convert's atomicity can't be accidentally deployed off.
- **No SQL duplication.** `PgConsumeStore` inlines copies of the statements it
  wraps, which is a drift risk (two definitions of one write). Instead the three
  item/derivation statements are parameterized on their `sql` handle
  (`insertItemIfAbsentWith` / `getItemWith` / `updateItemStateWith` /
  `insertDerivationWith`), the public methods delegate to them with `this.sql`,
  and `applyConversion` re-issues *the same* statements against the transaction
  handle. The `rawTx as unknown as postgres.Sql` cast is the same one
  `consume-store.ts` and `packages/pages/src/store.ts` already carry (postgres.js
  drops the tagged-template call signature from `TransactionSql`).
- **`applyItemStateUpdate`** — one exported pure definition of what an
  `ItemStateUpdate` does to a record. Three places need it and would otherwise
  each hold their own copy: `PgInventoryStore`'s UPDATE, `MemoryInventoryStore`'s
  in-place merge, and the new planner's *projection* (below).
- **The planner projects forward, because the old loop re-read.** The old
  write-as-you-go loop called `getItem` per source *after* the previous source's
  write, so a source named twice in one conversion decremented twice. Planning
  everything from one pre-transaction read would have silently changed that to
  once — a behavior regression in the under-reporting direction, which is exactly
  what this plan is about. The planner therefore threads each source's projected
  post-decrement state forward through a map keyed by ULID, so the second line
  plans against the remainder the first leaves. The memory store's rollback
  snapshots by the same key, so a twice-named source restores to its ONE original
  state rather than to the intermediate.
- **Retries stay un-deduplicated, and that is a decision, not an omission.**
  `insertItemIfAbsent` implies idempotency on a supplied ULID, but convert *mints*
  the derived ULID, so a replayed request makes a second batch and spends the
  sources again. Adding a key was considered and rejected for this verb: "I made
  another batch" is an ordinary repeated act, so two identical convert requests
  are far more likely to be two real batches than one double-sent one, and
  collapsing them would lose a batch — the same under-reporting failure in a new
  costume. `consume` differs because its `ulid` is a *journal entry's*, and the
  offline queue that replays it has one real entry per tap. Atomicity is what
  makes each attempt whole; deduplicating attempts is a separate contract change
  (an optional caller-supplied derived ULID) and is stated as such in the spec so
  it can't be mistaken for an oversight. Double-sends are corrected with
  `inventory dismiss` / `merge`.
- **Test fault injection** mirrors `MemoryConsumeStoreTestHooks`: two optional
  hooks on `MemoryInventoryStore` (`beforeDerivedInsert`,
  `beforeDerivationInsert`) firing between the write phases, inside the try/catch
  that rolls back. They double as the assertion that a *rejected* request never
  reaches the write phase — a hook that would have thrown proves the transaction
  never opened.

## Validation

- [x] `bun run test`, `bun run build`, `bun run type-check:axi`,
      `bun run check:skills` all green.
- [x] Source decrements roll back when the derived item's insert fails.
- [x] The derived item is not visible — not by `getItem`, not in
      `listItems`/`listInventory` — when the derivation insert fails.
- [x] A multi-source convert rolls back **every** source, not just the last one
      applied (the first-planned source is the one a partial undo misses).
- [x] A successful convert is unchanged: source states/quantities, the derived
      item's clock and quantity model, and the full ordered provenance list all
      match pre-change behavior; the whole pre-existing conversion suite still
      passes untouched.
- [x] The memory store matches the SQL store on every rollback path (three
      forced-failure shapes, plus the missing-source abort).
- [x] A conversion that spends one source twice still decrements twice, and
      rolls that source back to its ORIGINAL quantity.
- [x] A source driven terminal by an earlier line of the same conversion is
      rejected and spends nothing.
- [x] Each of the five rejection paths (terminal source, unknown source,
      non-integer amount against a counted source, missing `derived.name`,
      package-durable shelf-life class) refuses before the write phase opens.
- [x] The pg half validated against a real Postgres — see Notes.
- [x] No migration: additive code only, no schema change.

## Risks / unknowns

- **The transaction does not add row locking.** Two conversions spending the
  same source concurrently still each read, plan, and write; the later write
  overwrites rather than compounding, so one decrement can be lost. That race
  pre-dates this change and is unchanged by it — the fix here is about a *single*
  attempt never landing half-applied. A `SELECT … FOR UPDATE` inside
  `applyConversion` would close it, but the read that the plan is computed from
  happens before the transaction opens, so the lock would have to move the
  count/fraction decision into the store. Left alone deliberately: a single-owner
  kitchen ledger has no realistic concurrent-convert path, and the shape of the
  fix (move planning inside the transaction) is worth doing once, with the
  eat-first read paths, rather than piecemeal.
- **`MemoryInventoryStore` rollback is snapshot-restore, not a real
  transaction.** It restores the maps it touched; a caller holding a reference to
  a source record across a failed `applyConversion` sees the restored object (the
  map entry is replaced, not merged). Nothing does, and the pg path is what
  production runs, but the mirror is a mirror and not a proof.
- **`applyConversion`'s duplicate-derivation guard is duplicated logic.** Pg
  enforces `UNIQUE (derived_item_ulid)`; the memory store has to check by hand or
  it would silently overwrite provenance where pg raises. Two enforcement points
  for one constraint, kept because the alternative is a mirror that disagrees with
  the database on a corruption case.
- **`MemoryInventoryStore` gained a constructor.** It was constructed with no
  arguments in ~40 places; the hooks parameter is optional, so every existing site
  is unaffected, but it is now a class whose shape a future required argument
  could break widely.

## Notes

- **The issue's proposed shape was wrong in a way worth recording.** #156 reads
  the fix off `consume-store.ts` and prescribes a `convert-store.ts` with a memory
  twin. Following it literally would have added a third store interface, an
  injection point in `InventoryPipelineConfig`, wiring in `index.ts`, an update to
  every test that constructs a pipeline, and — the real cost — a second store that
  can be *unwired*, exactly the `503 ConsumeNotConfiguredError` failure mode
  `consume` carries. The seam that justifies `ConsumeStore` (entries live in
  `EntryStore`, items in `InventoryStore`) does not exist for convert. Verified
  against the schema rather than assumed: `applyConversionDecrement` →
  `updateItemState`, `insertItemIfAbsent`, and `insertDerivation` write
  `kitchen.inventory_items` and `kitchen.inventory_derivations`, both owned by
  `InventoryStore`; `convert` never touches `kitchen.entries` (which § Conversions
  states as a defining property of the verb).
- **The near-miss was the duplicate-source case, and it argues for planning
  forward rather than from one read.** The obvious refactor — read every source
  up front, plan all the decrements, then write — silently changes behavior when
  one source appears twice in a `sources` array: both plans compute from the
  original quantity, so the pack loses one line's worth instead of two. That is a
  fresh instance of the *same* under-reporting bug the plan exists to fix, arriving
  through the fix itself. Projecting each plan forward keeps the old loop's
  re-read semantics exactly, and two tests pin it (twice-named source decrements
  twice; a source driven terminal by an earlier line of the same conversion is
  rejected).
- **The Postgres half was validated against a real Postgres, because the suite
  can't reach the `sql.begin` path.** The unit suite runs on
  `MemoryInventoryStore`, so `applyConversion`'s actual transaction had no
  coverage. Applied all 18 kitchen migrations to a throwaway container and ran 23
  checks against `PgInventoryStore` directly:
  - **Commit** — both sources decremented (one to a remainder, one terminal with
    `closed_at` and a zeroed fraction), the derived item inserted, the derivation
    inserted with its two provenance entries in order; each confirmed by reading
    the tables back, not the returned records.
  - **Rollback on a real constraint violation, twice over.** Re-running a
    conversion with an already-used derived ULID makes `insertItemIfAbsent` no-op
    and the derivation insert collide on `UNIQUE (derived_item_ulid)`; a fresh
    derived ULID with an already-used *derivation* ULID collides on the PK after
    the item insert. Both raise mid-transaction with the source decrements already
    issued. In both cases every source row came back byte-for-byte identical
    (compared as whole rows, so `state`, `units_remaining`, `on_hand_fraction` and
    `closed_at` all had to match), no stray derivation row survived, and — the
    #156 case — the freshly-inserted derived item was **not** left behind.
  - **A source deleted out from under the transaction** aborts the conversion,
    rolls the sibling source back, and leaves no derived item.
  - **Source-less conversion** commits, and its empty `sources` persists as a
    JSONB `[]` rather than NULL (the `sql.json` binding), with `recipe_ulid`
    intact.
  - **The parameterization refactor didn't break the ordinary paths** —
    `updateItemState`, `getItem`, `insertDerivation` and `insertItemIfAbsent`'s
    conflict detection each still behave through their delegating public methods.
  - Container removed afterwards. No migration was involved and none was run
    against any real database.
- **`sql.begin` returns the callback's value**, so `applyConversion` needs no
  out-of-band result plumbing — the same shape `PgConsumeStore.consume` uses.
- The old `applyConversionDecrement` was doing two jobs: deciding the decrement
  and applying it. Splitting them is what made the transaction possible, and it
  also moved the counted-source `amount` validation to where it belongs — a
  request with a fractional count against a sealed pack now cannot have spent an
  earlier source before being refused.
- Verified before opening the PR: `bun run test` exit 0, every workspace package
  `0 fail` (kitchen 477 pass across 25 files, up from 463 across 24);
  `bun run build` exit 0 (14/14);
  `bun run type-check:axi` clean; `bun run check:skills` reports all bundles and
  SKILL.mds up to date. No CLI or skill surface changed, so no bundle rebuild.

## Follow-ups

- **Issue — row locking for the source reads (`SELECT … FOR UPDATE`).** Two
  conversions spending one source concurrently can still lose a decrement, and so
  can a conversion racing a `consume` or an `event finished` against the same
  item. The honest fix moves the count-vs-fraction planning inside the
  transaction, which changes where that business rule lives, so it wants its own
  design pass across every inventory write rather than a lock bolted onto this
  one. Not a regression from this change — the pre-existing race, now the only
  remaining way a single convert's arithmetic can be lost.
- **Deferred — an optional caller-supplied derived ULID, if a real double-send
  ever appears.** That is the shape retry-dedup would take (the caller mints the
  derived item's ULID, `insertItemIfAbsent` collapses the replay, and the
  derivation insert's `UNIQUE (derived_item_ulid)` makes the collapse total). It's
  a wire-contract change and it needs the "was this two batches or one request
  twice?" question answered by evidence, not guessed. Deliberately not built —
  the spec now states the non-idempotence as intended behavior so the next reader
  doesn't take it for an oversight.
- **None for the module's other multi-write events.** `consume` was already
  atomic; item merge (`mergeItems`) writes through several store calls but its
  steps are individually idempotent and re-runnable by design (§ Item corrections'
  replay rule), so it does not have this shape. `convert` was the outstanding one
  `consume-store.ts` named, and its comment now points at the closure instead of
  the gap.
