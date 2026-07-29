---
status: planned
depends: [item-corrections]
specs:
  - specs/modules/kitchen.md
issues: [157]
---

# Plan: Item state fidelity — storage moves, a reconcile that reaches, and counted-within-open-container

## Why

Three defects, one shape: **an inventory item's state cannot express what is
physically the case**, so the ledger doesn't merely lose detail — it asserts
something false. All three land on the same item model, which is why they ride
one change rather than three.

**1. A shelf-life class is a claim about where food lives, and food moves.**
`eat_by` derives from `shelf_life_class` + `acquired_at`/`opened_at`, a model that
assumes storage never changes. A sealed pack that goes freezer→fridge must restart
its clock **from the move**, not resume as though it had never been frozen, and
there is no event that says so. Both directions of the resulting mis-record
mislead, oppositely:

- Recorded as a fridge class, actually frozen → ages on paper while sitting safe.
  Eat-first nags with months of real life left; over a long enough freeze it reads
  expired. That trains the reader to distrust the whole list.
- **Recorded as frozen, actually thawed days ago → reads indefinitely safe while
  on a ~1-week fuse.** This is the dangerous direction, and the one the module
  exists to prevent.

The workaround an agent is tempted into — `--opened-at` on a sealed pack, because
it produces a plausible date — trades a wrong date for a wrong *state*.

**2. The reconcile verb cannot reach the fields a correction needs.** `PATCH
/kitchen/inventory/:ulid` is `additionalProperties: false` over exactly six
properties (`on_hand_fraction`, `units_total`, `units_remaining`, `state`,
`opened_at`, `notes`). So `shelf_life_class` — which is precisely the field a
storage move leaves wrong — plus `needs_info` and `product_ulid` are unreachable
by the verb documented as reconciling the ledger to observed reality. A caller
supplying them gets a validation rejection, correct for the schema and useless for
the job.

Compounding it: **`needs_info: true` suppresses `eat_by` entirely**, even when the
class is supplied explicitly at creation, so such items never enter eat-first. Two
fresh produce items seeded with a correct class sat invisible for hours because
their *brand* was unconfirmed. "I don't know what this is" and "this doesn't rot"
are unrelated facts, and an unidentified perishable is the one you most want a
clock on.

**3. A package can be both counted and openable, and the model made it choose.**
An item is either counted (`units_total`/`units_remaining`) or fraction-modelled.
Real packages are both: a 4-link sausage pack is a *container* that gets opened
(starting a shorter clock) and *also* holds discrete units eaten one at a time.
Bread slices, egg cartons, and a tray of prepped portions are the same shape.
Opening one forced a false choice — keep counting and lose the opened clock, or
switch to a fraction and lose the count. Both discard something true, and the
first discards it in the under-reporting direction.

## Scope

Semantics are settled in `specs/modules/kitchen.md` § Storage moves, the rewritten
§ count-vs-fraction, the amended § Reconcile / § Shelf-life classes / § Inventory
state machine / § API / § JSON shapes / § Principles; implementation does not
re-litigate them.

1. **A `moved` event** (`POST /inventory/:ulid/events` with `type: 'moved'`,
   `to: <class>`) that sets the destination class, stamps `storage_moved_at`,
   re-anchors `eat_by` from the move date, leaves state and `opened_at` untouched,
   and appends a `moved <from>→<to> <date>` audit line. State-preserving in the
   transition table; `409` on a terminal item. Freezer→fridge and fridge→freezer
   are the same mechanism.
2. **Widen reconcile** to `shelf_life_class`, `needs_info`, `product_ulid`, and
   `unit_seal`, keeping `eat_by` derived-only. Plus the `needs_info`/`eat_by`
   decoupling at create.
3. **`unit_seal: 'individual' | 'shared'`** — the counted-within-open-container
   model, with `finished-unit`, `consume`'s counted branch, and every eat-first
   read behaving correctly across it, and `on_hand_fraction` becoming a **derived**
   read for counted items.

**Out of scope, with reasons:**

- **Row locking / concurrent-write safety.** A real gap, and a pass across every
  inventory write rather than a rider on this one — every read-modify-write here
  (`updateItemState`, reconcile, the event pipeline) has the same window, and it
  predates this change. Filed under Follow-ups.
- **No migration run against any database.** `019` is additive with nullable
  columns and applies on next boot; nothing here backfills or rewrites a row.
- **The receipt parser, the estimator, and the pages module** are untouched.
- **Extending the label scan's `unit_model_hint` to distinguish the two seals.**
  It is currently `'counted' | 'fraction'`; a third value would be a genuine
  packaging judgment a vision model could make from a photo, but it means a prompt
  change with its own false-positive budget. The seal is caller-stated for now.
- **Backfilling `unit_seal` on existing counted rows.** Null reads as
  `individual`, which is exactly the behavior those rows already had, so there is
  nothing to backfill — and no way to tell a can pack from a sausage pack from
  stored data anyway.

## Implements

- `specs/modules/kitchen.md` § Storage moves — the whole section (the two
  mis-record directions, what `moved` does, same-class and terminal handling,
  act-not-intention dating, and the reasoned refusal to null a frozen `eat_by`).
- `specs/modules/kitchen.md` § Shelf-life classes — `eat_by` as **anchor +
  window** with `storage_moved_at` in the anchor, and the clock-is-orthogonal-to-
  `needs_info` rule.
- `specs/modules/kitchen.md` § count-vs-fraction — the rewritten section:
  `on_hand_fraction` derived for counted items, `unit_seal`'s two kinds, and
  `finished-unit`'s seal-dependent outcome including the implied open.
- `specs/modules/kitchen.md` § Reconcile — the reaches-every-field rule, and the
  class-correction-vs-storage-move distinction.
- `specs/modules/kitchen.md` § Inventory state machine — the state-preserving
  `moved` transition.
- `specs/modules/kitchen.md` § Consume from inventory § Depletion — the counted
  branch's seal split.
- `specs/modules/kitchen.md` § Data model — `inventory_items.storage_moved_at`
  and `.unit_seal`; § API — the amended events / reconcile / create / convert
  bodies; § JSON shapes — the `InventoryItem` additions.
- `specs/modules/kitchen.md` § Agent tooling + § Principles — the `moved` and
  `--unit-seal` surfaces, the count-and-openable-are-independent-axes principle,
  and the state-must-express-reality principle.

## Approach

- **Migration `019-kitchen-storage-moves-and-unit-seal.sql`** — additive `ADD
  COLUMN IF NOT EXISTS storage_moved_at DATE` and `unit_seal TEXT`, with the
  `unit_seal` value `CHECK` in a `DO $$ … EXCEPTION WHEN duplicate_object` block
  (the `017`/`018` idiom — a constraint can't ride `ADD COLUMN IF NOT EXISTS`
  idempotently). `TEXT` + `CHECK` rather than a new PG enum: two values, and a
  text check is re-runnable where `CREATE TYPE` is not.
- **`deriveEatBy` gains `storageMovedAt`** and picks `anchor = max(base,
  storageMovedAt)`, where `base` is the existing opened/acquired choice. `max`
  rather than a fourth branch is what makes move-then-open and open-then-move both
  come out right with no ordering rule, and it keeps `prepared`'s
  ages-from-the-make-date exception intact (a frozen batch thawed today still
  re-anchors, because a move is a physical intervention on the whole item where
  opening is not).
- **`toItemView` derives `on_hand_fraction`** from the count when the item is
  counted, and surfaces `unit_seal` (null → `individual` on a counted item) and
  `storage_moved_at`. Stored `on_hand_fraction` is left alone rather than migrated:
  it is simply not the source of truth for a counted item, and every internal
  reader already dispatches on the unit model.
- **`unitSealOf(record)`** as the one place `null → 'individual'` is decided, so
  the default can't drift between the event path, the consume path, and the view.
- **Service** — a `moved` branch in `applyEventToRecord` (before the transition
  call, like `finished-unit`'s), the seal split in `finished-unit` and `consume`,
  and reconcile widened field by field with the product lookup validating live-ness
  and naming a `merged_into` survivor when there is one.
- **Store** — `ItemStateUpdate` gains `shelf_life_class`, `storage_moved_at`,
  `unit_seal`, `needs_info`, `product_ulid`; `NewItem` gains `unit_seal`.
  `applyItemStateUpdate` (the reference merge the memory store and the conversion
  planner both use) and `PgInventoryStore`'s UPDATE move in lockstep, and
  `PgConsumeStore`'s inline copy of that UPDATE gains the same columns.
- **Briefing** — its eat-first SQL reads `on_hand_fraction` directly, so it gets
  the same `units_remaining / units_total` derivation inline; otherwise the daily
  read would keep reporting `1.0` for a nearly-empty pack while every other
  surface told the truth.
- **CLI** — `event <ulid> moved --to <class>`, `recount --shelf-life/--needs-info/
  --no-needs-info/--product-ulid/--unit-seal`, `add --unit-seal`, plus
  `reference.ts` entries so `--help` and the spliced SKILL.md carry them.

## Validation

- [ ] `bun run test`, `bun run build`, `bun run type-check:axi`,
      `bun run check:skills` all green.
- [ ] A sealed pack acquired frozen and `moved --to fridge_short` on day 8 gets an
      `eat_by` of day 8 + the fridge unopened window — not day 0 + it, and not a
      resumed frozen clock.
- [ ] The inverse works: an **opened** item moved to `frozen` takes `frozen`'s
      **opened** window from the move date, and its `opened_at` and state survive.
- [ ] A move records `moved <from>→<to> <date>` in `notes`, and repeated moves
      re-anchor to the latest while keeping every line in the note history.
- [ ] A move into the item's current class still re-anchors (not a no-op); `to:
      'unknown'` is `400`; a `to` on any other event type is `400`; a `moved` on a
      terminal item is `409`.
- [ ] The reported date is the act's date: `--at` yesterday anchors to yesterday,
      omitted `--at` anchors to today.
- [ ] A frozen item keeps an `eat_by` and sorts below perishables in the eat-first
      read rather than being suppressed.
- [ ] `PATCH` accepts `shelf_life_class`, `needs_info`, `product_ulid`, and
      `unit_seal`; a `shelf_life_class` correction re-derives against the existing
      anchor and does **not** stamp `storage_moved_at`.
- [ ] `product_ulid` on reconcile clears `needs_info`, adopts the product's class
      only when the item has none, folds in the product's day-window overrides,
      and rejects an unknown or archived target (naming the survivor when the
      archived product was merged).
- [ ] An item created with `needs_info: true` **and** an explicit class derives an
      `eat_by` and appears in eat-first; a receipt-seeded `needs_info` item with no
      class still has `eat_by: null`.
- [ ] `finished-unit` on a `shared`-seal counted item keeps it `open`, keeps
      `opened_at`, keeps the opened-window `eat_by`, and decrements the count;
      the last unit still goes terminal `finished`.
- [ ] `finished-unit` on a **stocked** `shared`-seal item implies the open (stamps
      `opened_at` at the event date, derives the opened window).
- [ ] `finished-unit` on an `individual`-seal item is unchanged: back to `stocked`,
      `opened_at` cleared, fresh unopened clock.
- [ ] `consume` with `--quantity` follows the same split on both seals.
- [ ] `on_hand_fraction` on the wire is `units_remaining / units_total` for a
      counted item (`1` of `4` reads `0.25`, zero reads `0`), and untouched for a
      fraction-modeled one. `PATCH on_hand_fraction` on a counted item still `400`s.
- [ ] The interaction case: a counted `shared`-seal pack that is **opened, then
      moved between storages** keeps its count, keeps `open`, and takes the
      destination class's **opened** window from the move date.
- [ ] `unit_seal` is refused without a count (on create and on reconcile), and
      reverting a counted item to the fraction model clears it.
- [ ] Migration `019` re-applies cleanly (both `ADD COLUMN IF NOT EXISTS` and the
      `DO $$` CHECK block no-op on a second run).
- [ ] `moved`, `--unit-seal`, and the widened `recount` flags appear in the
      generated reference and the spliced SKILL.md.

## Risks / unknowns

- **`unit_seal` null meaning `individual` is implicit.** The alternative — `NOT
  NULL DEFAULT 'individual'` — would state it in the schema but claims a seal for
  every fraction-modeled row, where the notion doesn't apply. Nullable with one
  `unitSealOf` helper keeps the migration free of backfill and keeps "no seal" and
  "individually sealed" distinguishable in storage; the cost is that the default
  lives in code, so it is asserted by test rather than by constraint.
- **A stale freeze is still undetectable.** Nothing can tell that an item recorded
  `frozen` was thawed and never logged; the fix is that logging the thaw is now one
  call instead of impossible. Making the frozen class *expire* into a warning was
  considered and rejected — it would fabricate a transition on the module's own
  authority, which is the fiction this whole plan is about removing.
- **`on_hand_fraction` becoming derived is a wire-behavior change for counted
  items**, from a stale `1.0` to the honest fraction. Any client reading it as
  "how much of the package is left" gets a better answer; a client using it to
  detect "has this been touched" would now see motion it didn't before. Judged
  strictly an improvement — the old value was wrong — and the field's meaning is
  now stated in § JSON shapes.
- **Reconcile can now set `product_ulid`, which narrows merge's stated role.**
  § Item corrections called merge "the only way to attach a product to an existing
  item"; that was true and is no longer. Merge keeps every other reason to exist
  (it relinks dependents, which a relink has none of), and the CLI help that made
  the exclusive claim is corrected rather than left to mislead.
- **Every inventory write is still read-modify-write with no row lock.** Out of
  scope here, and this change adds writes to that pattern without making the
  pattern worse (the `moved` and reconcile paths are read-then-update exactly like
  `opened` already was).

## Notes

*Populated at closeout.*

## Follow-ups

*Populated at closeout.*
