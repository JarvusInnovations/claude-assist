---
status: done
depends: [product-corrections]
specs:
  - specs/modules/kitchen.md
issues: [162]
pr: 163
---

# Plan: Item corrections — reach `dismiss` from the CLI, and merge duplicate items

## Why

Two records for one physical package, a day apart on their clocks, both on hand.
Eat-first therefore reported twice the stock that existed — the ledger claiming
*more* than reality, the direction nothing downstream flags. Neither half of the
repair was available to the agent that hit it.

**The retirement path existed and could not be found.** `POST
/inventory/:ulid/dismiss` has shipped since the needs-info flow (migration
`004`), with exactly the right semantics for a record that was never real stock:
terminal, no waste note, `on_hand_fraction` untouched, so neither consumption nor
waste telemetry is polluted. But `inventory --help` lists `list, show, add,
event, recount, remark, questions, convert, consume` — no `dismiss` — and `event`
accepts only `opened|finished|finished-unit|tossed`. So `dismissed` is reachable
through neither its own subcommand nor the event enum, and `DELETE
/kitchen/inventory/:ulid` answers `404`, which reads as "no removal path exists"
when the truth is "the removal path is a POST under a different name."

The workaround an agent *can* reach is the misrepresenting one. `event finished`
records a consumption that never happened, and it makes the item terminal, so the
correct verb then `409`s — recovering required `recount --state stocked` to
resurrect before dismissing. Cost of the gap: a fabricated consumption in the
ledger, plus a two-step recovery, for a record that had a one-call retirement all
along.

**Merge is genuinely absent.** Dismissal retires a row but relinks nothing, so
for a true duplicate with history on both sides — a consumption entry that
depleted the loser, the receipt line that created it, a conversion that spent it
— dismissing alone strands those links against a record that is no longer stock.
Items are also the only records whose `product_ulid` no write can move (#157):
when the identity was established on the *other* row, merge is the only door.

This is the fourth instance of the same shape: recipes got upsert + archive
(#155), products got patch + upsert + merge (#160), items had retirement but no
way to find it and no merge at all.

## Scope

Semantics are settled in `specs/modules/kitchen.md` § Item corrections and the
amended § Non-inventory dismissal / § Inventory state machine / § Agent tooling;
implementation does not re-litigate them.

1. **`inventory dismiss <ulid> [--non-inventory]`** — its own subcommand, not a
   member of the `event` enum. Reasons, in order of weight: the CLI's stated
   invariant is one command per documented endpoint and `dismiss` is its own
   endpoint; its response is `{ item, dismissed_count, non_inventory }`, not the
   bare item `event` renders, so folding it in would make one verb's output
   shape depend on its argument; and `--non-inventory` has no analogue in the
   event body. `event <ulid> dismissed` is then a **guided refusal** naming the
   real verb, so the enum's shape stops being a dead end for anyone who guesses.
2. **Enumerate the reachable states in `inventory --help`** — all five, each with
   the verb that reaches it, including resurrection via `recount --state`. The
   discoverability half of the defect, and the cheaper half.
3. **`POST /inventory/:ulid/merge {into}`** — the product-merge shape (#160)
   applied to items: fill only the survivor's null identity fields, relink every
   real dependent with per-table counts, retire the loser as `dismissed` with
   `merged_into`. Idempotent; `400`/`404`/`409` per the spec. Plus `inventory
   merge <ulid> --into <ulid>`.

**Out of scope, with reasons:**

- **The duplicate-creation bug itself is client-side and is not fixed here.**
  Diagnosis under Notes. Nothing in this repo emits the placeholder label the
  duplicate carried, and no server route creates an item during a label scan
  (`POST /inventory/:ulid/label` `404`s on an unknown item), so the second row
  came from a client `POST /inventory`. The capture app is a different repo and
  deliberately untouched.
- **A server-side near-duplicate guard on `POST /inventory`.** Considered and
  rejected — argued under Notes. The inserted row carried no identifying
  information at all, so there is nothing at insert time for a guard to match on.
- **Backfilling existing duplicates.** Choosing which of two real rows survives
  is a judgment about an instance's own data; it is now one CLI call.
- **Summing quantities on merge**, and **rewriting a merged loser's waste
  notes** — both under Risks.

## Implements

- `specs/modules/kitchen.md` § Item corrections — the whole section (the three
  distinct correction affordances, and `POST /inventory/:ulid/merge`'s five
  steps, rules, idempotency, and response shape).
- `specs/modules/kitchen.md` § Non-inventory dismissal — dismissal as the
  phantom-retirement path, not only a receipt-line one.
- `specs/modules/kitchen.md` § Inventory state machine — `dismissed` is reached
  by its own verb and is the terminal a merge retires into.
- `specs/modules/kitchen.md` § API — the `POST /inventory/:ulid/merge` endpoint
  and the amended dismiss bullet.
- `specs/modules/kitchen.md` § Data model + § JSON shapes —
  `inventory_items.merged_into`.
- `specs/modules/kitchen.md` § Agent tooling — `dismiss`/`merge`/`recount` on the
  documented `inventory` surface, and the every-state-enumerated rule.

## Approach

- **Migration `018-kitchen-item-merge.sql`** — additive `ADD COLUMN IF NOT
  EXISTS merged_into CHAR(26)`; the ULID `CHECK` rides a `DO $$ … EXCEPTION WHEN
  duplicate_object` block, since a constraint cannot be added idempotently
  alongside `ADD COLUMN IF NOT EXISTS` (same shape as `017`).
- **Types** — `merged_into` onto `InventoryItemRecord` + `InventoryItemView`
  (`rowToItem`/`toItemView` map it); new `ItemMergeResult` / `ItemRelinkCounts`.
- **Store** — `relinkItemReferences(from, to)` returning per-table counts, and
  `retireMergedItem(ulid, mergedInto, at)` (COALESCE-idempotent, mirroring
  `archiveProduct`); an `updateItemIdentity` for the survivor's gap fill. Memory
  store mirrors each.
- **Entries live in the other store.** `kitchen.entries` is phase-1 territory
  owned by `EntryStore`, which is why the depletion matcher gets `linkEntry`
  injected rather than reaching across. The relink follows that seam:
  `EntryStore.relinkInventoryItem(from, to)` on both implementations, injected as
  `relinkEntries` in the pipeline config and wired in `index.ts`. Reported count
  is honest when the hook is absent (the route reports what it actually moved).
- **Service `mergeItems`** — gap fill, then `resolveNeedsInfo` when the fill
  identified the survivor (which is also what re-derives `eat_by` off the
  survivor's own clock), then relink, then retire. `ItemValidationError` (400) /
  `ItemConflictError` (409) with an `itemErrorReply` in the routes, mirroring
  `productErrorReply` so no door can answer with a different code.
- **CLI** — `dismiss` and `merge` subcommands, the guided `event … dismissed`
  refusal, a states block in `INVENTORY_HELP`, and `reference.ts` entries so
  `--help` and the spliced SKILL.md carry both verbs.

## Validation

- [x] `bun run test`, `bun run build`, `bun run type-check:axi`,
      `bun run check:skills` all green.
- [x] `dismiss` is reachable from the CLI, sends `non_inventory` only when asked,
      and its usage appears in the generated reference + SKILL.md.
- [x] `dismiss` on an already-terminal item is refused (`409`), and
      `event … dismissed` is refused with a pointer to `dismiss` rather than a
      bare enum error.
- [x] `inventory --help` names every reachable state and the verb for each.
- [x] Merge relinks each real dependent: a consumption entry, a purchase batch
      line, a conversion's `sources[].item_ulid`, and the 1:1
      `derived_item_ulid` (moved only when the survivor has none).
- [x] Merge fills only the survivor's null identity fields, never overwrites a
      non-null one, and never sums quantities.
- [x] A `needs_info` survivor that gains `product_ulid` from the loser clears
      `needs_info` and re-derives `eat_by` from **its own** clock, not the
      loser's.
- [x] Merge idempotency: a replay into the same survivor succeeds with zero
      relinks and does not slide `closed_at`.
- [x] `400` self-merge, `404` unknown either side, `409` merged-away survivor and
      `409` loser-merged-elsewhere.
- [x] A loser that is already terminal still merges, and ends `dismissed`.

## Risks / unknowns

- **Merge retires the loser as `dismissed` from any state, overriding a prior
  terminal.** Deliberate — the merge asserts the row was never independent stock,
  so a `finished`/`tossed` on it is a claim about food that does not exist, and
  retracting it is the point (that `finished` is exactly what the missing
  retirement path forced). The residue: a partial toss already appended a
  `tossed <amount> <date>` line to `notes`, and waste telemetry reads those
  notes, so a mis-tossed duplicate's waste line survives the merge. Left alone
  rather than parsed-and-stripped — rewriting an audit line is worse than a
  documented one — and noted as a follow-up.
- **The gap fill is narrow on purpose.** Only five identity fields participate,
  and only into nulls. A wider fold would have to decide between two clocks, two
  quantities, and two note histories, and every one of those choices is the
  over-reporting the duplicate caused. `recount` covers the rest, as an
  observation.
- **`derived_item_ulid` is 1:1 and cannot always move.** When the survivor
  already carries provenance, the loser's stays with the loser and the count
  reports `0`. The alternative (dropping one) destroys provenance to satisfy a
  constraint.
- **The entries relink crosses a store seam** and is therefore only as complete
  as its injected hook. In the server wiring it is always present; a pipeline
  constructed without it (some unit tests) reports `entries: 0` honestly rather
  than silently claiming a move.

## Notes

- **The reachability fix was the whole retirement half, and it was documentation
  plus one subcommand.** Nothing server-side needed to change for asks 1 and 2:
  `POST /inventory/:ulid/dismiss` already had the right semantics, the right
  fan-out, and the right `409`. What it lacked was a name an agent could find. The
  durable part of the fix is therefore the shape of the help, not the subcommand:
  the five states are enumerated with the verb that reaches each, `event …
  dismissed` redirects instead of refusing, and a test asserts every state name and
  both verbs appear — so the next verb added to the endpoint surface cannot go
  unlisted the same way.
- **`recount` was missing from the generated reference too**, found while adding
  `dismiss`. It was documented in `inventory --help`'s group text but absent from
  `COMMAND_GROUPS`, which generates the top-level `--help` and the SKILL.md
  reference — the same failure class one level up, and the reconcile verb is the
  one an agent needs to undo a wrong close.
- **`dismiss` as its own subcommand, not an event enum member.** The deciding
  argument was the response shape: `event` renders the bare item, `dismiss` answers
  `{ item, dismissed_count, non_inventory }`. Folding it in would make one verb's
  output shape depend on its argument, which is worse for an agent than one more
  verb. `--non-inventory` having no analogue in the event body and the CLI's
  one-command-per-endpoint invariant both point the same way.
- **Merge dismisses the loser from ANY state, including a terminal one.** This fell
  out of the motivating case rather than being designed: the phantom had already
  been closed with `event finished` (the only retirement reachable at the time), so
  refusing to merge a terminal loser would have made merge useless for exactly the
  records that needed it. Framing it as "the merge asserts this row was never
  independent stock" makes the override principled rather than expedient — and it
  retracts the fabricated consumption instead of preserving it.
- **The gap fill is five fields into nulls, and that narrowness is the design.**
  Every wider fold has to choose between two clocks, two quantities, or two note
  histories, and each of those choices is the over-reporting the duplicate caused.
  `product_ulid` is the one that matters: it is unreachable through `PATCH` (#157),
  so merge is the only door that can attach an identity to an existing item, which
  is what the motivating case actually needed.
- **The dependent tables were verified against the schema, not the issue text.**
  The issue named `entries.inventory_item_ulid`, "derivations", and "depletion
  history". Reality: `kitchen.entries.inventory_item_ulid` (real),
  `kitchen.purchase_batch_lines.inventory_item_ulid` (real, unnamed in the issue),
  and `kitchen.inventory_derivations` in **two** distinct roles —
  `derived_item_ulid` (the conversion that MADE the item, `UNIQUE`/1:1) and
  `sources[].item_ulid` inside JSONB (conversions that SPENT it). There is no
  separate depletion-history table; depletion history *is* the entries link. The
  1:1 constraint is why `derivations` can legitimately report `0`.
- **`derived_item_ulid` moving at all is a real enrichment, not bookkeeping.** A
  derived item's conversion provenance is what makes it consume-eligible, so
  merging a made item into a plain one carries eligibility across — covered by a
  test, together with the survivor-already-has-one case.
- **Ask 4 is client-side. Diagnosed, not fixed, and deliberately so.** The evidence
  in the issue is conclusive on its own and the code confirms it:
  - The duplicate carried `raw_label: "New item"`. That string exists nowhere in
    this repo — no route, service, parser, or migration emits it. It was sent.
  - `POST /inventory/:ulid/label` cannot create an item: `resolveLabel` reads the
    item first and returns null (→ `404`) when the ULID is unknown. No label path
    inserts.
  - The duplicate's `store` was null and its `acquired_at` was the scan date, both
    consistent with a fresh `POST /inventory` carrying no receipt context — not
    with any server-side derivation from the existing row.

  So the capture client's "scan something new" flow mints a blank placeholder item
  and then scans its label, instead of scanning the label of the existing
  `needs_info` item. The affordance it should use already exists and is already
  handed to it: `GET /inventory/questions` returns each group's `item_ulid` **and**
  `item_ulids`, precisely so a scan can target the existing question (and fan out
  across its physical units).
- **A server-side near-duplicate guard on `POST /inventory` was considered and
  rejected.** At insert time the row carried no identifying information at all —
  placeholder label, no store, no product, no clock to overlap. There is nothing to
  match on, so a guard would have to fire on the *shape* of the request ("a
  content-free `needs_info` item"), which is also the shape of the legitimate flow
  (scanning something bought without a receipt). Rejecting it would break a real
  path to catch a mistake it cannot actually identify. The moment the duplicate
  becomes detectable is the label *resolve*, which is a different feature — filed
  as a follow-up rather than half-built here.
- Verified before opening the PR: `bun run test` exit 0, every workspace package
  `0 fail` (kitchen 463 pass); `bun run build` exit 0 (14/14); `bun run
  type-check:axi` clean; `bun run check:skills` reports all four bundles and
  SKILL.mds up to date. Full-diff and commit-message scrub scan clean.
- The three unrelated CLI bundles were reverted after `build:skills` touched only
  their VERSION git-SHA stamp, so the diff stays on `kitchen-axi.mjs`.

## Follow-ups

- **The duplicate-creation bug itself — a client fix, in the capture app's repo.**
  The scan-something-new flow should resolve an existing `needs_info` question when
  one plausibly matches, rather than minting a placeholder item; the questions
  endpoint already hands it the target ULIDs. Nothing in this repo blocks it.
- **Deferred — make the mistake impossible server-side: a label scan with no item.**
  A `POST /inventory/label` (no `:ulid`) that takes the photos, resolves the
  product, and then *decides* whether to attach the scan to an existing open
  `needs_info` item or create one would move that judgment off the client entirely.
  That is the durable fix, and it needs its own matching policy (what counts as a
  match, what happens on ambiguity), its own wire shape, and its own spec section.
- **Deferred — make it detectable: `possible_duplicates` on the label response.**
  The resolve path already knows the product it just linked; reporting open
  `needs_info` items whose `raw_label` plausibly matches that product's
  name/aliases would surface the case without acting on it, in the module's
  existing conservative-match idiom. Additive to a compound response, so it is
  contract-safe — but it is a new matching policy with a real false-positive
  budget, not a one-liner.
- **Tracked here, not fixed — a merged loser keeps its `tossed <amount> <date>`
  note.** Waste telemetry reads those notes, so merging a mis-*tossed* duplicate
  retracts its state but not its waste line. Parsing and stripping an audit line is
  worse than leaving it; the honest sequence today is to fix the record before
  merging. Revisit if waste costing starts reading state instead of notes.
- **None for duplicates that already exist in an instance.** Choosing which of two
  real rows survives is a judgment about that instance's own data, and it is now one
  CLI call (`inventory merge <dupe> --into <survivor>`), which is the point.
