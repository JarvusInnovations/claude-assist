---
status: done
depends: [kitchen-ledger-integrity, item-corrections]
specs:
  - specs/modules/kitchen.md
issues: [172]
pr: 173
---

# Plan: stated-weight consumption — eating a measured amount is not a correction

## Why

There is no verb for "I ate 230 g out of this open tub."

One-tap consume needs a *known* portion, which a divisible container does not have.
Reconcile is an **observation** — it asserts the ledger was wrong and carries no
consumption claim by design. So callers with an exact weight in hand reach for
reconcile, because it is the only thing that moves the number.

Observed in a production ledger: a prep-sheet meal was logged as a born-`manual`
entry and its four components depleted with four reconciles, each annotated in prose
with the grams eaten and the meal they went into. The same pattern had already
accumulated on a cooked-grain batch over several days. Nothing was *wrong* in the
numbers — and the ledger still tells a false story.

Two costs, both quiet:

- The item's history reads as a **run of measurement errors** rather than a meal
  log. Provenance for "where did this batch go" cannot be reconstructed.
- **Waste telemetry cannot separate food eaten from a fraction adjusted away**
  (§ Waste costing). Reconcile deliberately claims neither consumption nor waste, so
  every eaten gram routed through it is invisible to both.

Both under-report in the direction nobody audits.

## Scope

1. **Spec** — § Stated-weight consumption, stated as its own event and explicitly
   distinguished from § Reconcile.
2. **The endpoint + store method** — decrement by stated amount, optional atomic
   entry link.
3. **CLI** — a subcommand whose help text draws the reconcile boundary explicitly.

**Out of scope, with reasons:**

- **Any change to reconcile.** It stays exactly right for its own case: the
  container is emptier than the ledger thinks and nobody knows why.
- **Cook mode adopting this verb.** § Cook mode deliberately performs *exactly one
  atomic write per submission — no straddling*, and an `eaten` submission
  intentionally does not decrement (depletion goes through the best-effort matcher).
  Making cook mode also deplete would overturn a stated design decision and deserves
  its own argument, not a silent ride-along on this plan.
- **Backfilling the historical reconciles.** They are annotated in prose and
  re-interpreting them would be guesswork.

## Implements

- `specs/modules/kitchen.md` § Stated-weight consumption — the event, the
  grams-or-fraction amount rule, terminal-on-zero behaviour, and the optional atomic
  entry link.

## Approach

- **Never invent the mass denominator.** Fraction-modeled items track a directional
  fraction, not mass, so grams→fraction needs a `net_content_g` the ledger may not
  hold. Where it is absent, accept a fraction directly and say so. A guessed basis
  does not produce one wrong number, it **mis-scales every subsequent decrement on
  that item** — the compounding is what makes guessing unacceptable here rather than
  merely imprecise.
- **Reuse the consume transaction pattern** where an entry ULID is supplied: both
  writes commit together or neither does, per the hard requirement § Consume from
  inventory already states. Without an entry ULID it is a depletion alone, still
  recorded as consumption.
- **Terminal on exact-or-over-zero only.** A stated weight is an estimate of what
  left the container, so landing precisely on zero is coincidence; auto-closing on
  arithmetic would retire items still holding a smear, while never closing invites
  a drift of near-zero ghosts. Closing only when the arithmetic reaches or passes
  zero, and leaving any positive remainder alone, errs toward the recoverable side —
  a stale item is visible in eat-first, a wrongly-closed one is not.
- **`finished`, never `tossed`.** The food was eaten. Routing it through the waste
  path would corrupt the very telemetry this plan exists to protect.
- **The CLI help text is load-bearing, not polish.** The defect exists *because*
  reconcile was reachable and correct-adjacent. Two verbs that look similar will be
  confused again unless the difference is stated where the caller is choosing.

## Validation

- [x] `bun run test`, `bun run build`, `bun run type-check:axi`, `bun run
      check:skills` green.
- [x] A stated weight off an open divisible item decrements by that amount and is
      recorded as **consumption**, not a correction.
- [x] With a consuming entry ULID, depletion and link commit atomically; a
      fault-injection test proves neither lands on a mid-transaction failure.
- [x] Without one, the consumption still records.
- [x] Exact-or-over-zero goes terminal `finished`; a positive remainder leaves the
      item open.
- [x] A terminal item never appears in waste telemetry from this path.
- [x] An item whose product has no `net_content_g` accepts a fraction and is given
      **no** invented gram basis.
- [x] Replaying the same idempotency key does not double-deplete.
- [x] Reconcile's behaviour is unchanged; its help text now draws the boundary.

## Risks / unknowns

- **Two similar verbs will be confused again.** Naming, help text, and the spec's
  explicit contrast are the whole mitigation. There is no structural way to stop a
  caller reaching for the wrong one.
- **The terminal-on-zero rule is a judgement call** and the spec records it as such.
  If near-zero ghosts accumulate in practice, the alternative (close on a small
  epsilon) is a tuning change, not a redesign.
- **Grams require a denominator that is often missing.** The fraction fallback keeps
  it honest but means callers get an inconsistent interface depending on whether a
  product carries net content — worth watching as a usability complaint.

## Notes

- **New endpoint, `POST /inventory/:ulid/consumed`, rather than a sixth
  `POST /inventory/:ulid/events` type.** The event surface returns the bare
  `InventoryItem`, and every event type shares one fraction semantic per
  call; this event carries an optional atomic entry link and answers a
  compound `{ item, entry, linked }`, which is exactly the reasoning that
  already gave `/consume` its own endpoint rather than folding it into
  `/events`. Two sibling one-off endpoints beat one endpoint whose response
  shape depends on its body.
- **The atomic write is a new method on the EXISTING `ConsumeStore`
  (`linkConsumption`), not a new store class.** `ConsumeStore` already owns
  the module's one deliberate crossing of the `EntryStore`/`InventoryStore`
  boundary; a second crossing belongs in the same file under the same
  rationale, not a parallel one. `MemoryConsumeStore` gained the mirror
  implementation and reuses the existing `beforeItemWrite` fault-injection
  hook — the same structural point (between the first write and the second)
  in both atomic operations.
- **Restricted to fraction-modeled items; a counted item is refused
  (`400 StatedConsumeValidationError`), not silently accepted.** A counted
  item already has an exact per-unit consumption verb (`finished-unit` /
  `consume`); "grams eaten off a can 3-pack" has no meaning the ledger can
  act on that isn't better served by the unit that came off.
- **`entry_ulid` is the idempotency key exactly when it's supplied — no key
  is invented for a bare depletion.** Mirrors `consume()`'s convention
  (its `ulid` doubles as the key). Without `entry_ulid` a replay isn't
  detected, same as `tossed`/`opened` today — a caller wanting idempotency
  supplies the entry link.
- **The amount is always a DELTA (the amount eaten), never a remainder.**
  Both `amount_g` and `fraction` mirror `tossed`'s "amount tossed" semantic,
  deliberately not `opened`'s absolute-remainder one — the two existing
  fraction conventions in this module disagree, and the wrong one silently
  picked here would have been a real footgun.
- **The provenance note (`consumed <amount> <date>[ — entry <ulid>]`) was
  chosen to structurally miss `TOSS_NOTE_SQL_PATTERN`/`parseTossNotes`
  (which anchor on literal `tossed …`), so a terminal item closed by this
  path is invisible to waste telemetry BY CONSTRUCTION** — no change to
  `wasteReport`/`listTossedCandidates` was needed or made, and a test proves
  it rather than asserting the absence of a code path.
- **The genuinely open design question — whether arithmetic alone should
  close an item — is resolved as the spec states**: exact-or-over-zero only,
  positive remainder left alone. Building it surfaced no reason to prefer
  the epsilon alternative; nothing here changes that risk's status as a
  judgement call to revisit if near-zero ghosts show up in practice.
- **The free-text resolver (`POST /inventory/events`) was deliberately left
  untouched.** The plan's scope names the endpoint, the store method, and
  the explicit CLI verb — not remark parsing. A remark like "ate 100g of the
  hummus" still falls through to the existing opened/finished/tossed/recount
  matching (or goes unmatched) rather than routing here. Filed as
  [#172](https://github.com/JarvusInnovations/claude-assist/issues/172).
- Verified before opening the PR: `bun run test` exit 0 across every
  workspace package (kitchen 685 pass, 0 fail) — `mealbank.test.ts` hit its
  known cold-`gitsheets`-invocation hook-timeout flake on the first full run
  and passed clean on the immediate re-run, twice; per the task's own
  known-quirk note this was not touched. `bun run build` exit 0 (14/14
  packages). `bun run type-check:axi` clean. `bun run check:skills` reports
  all four bundles and SKILL.mds up to date. Full diff and commit message
  scanned for leaked names/identifiers — clean. Three unrelated CLI bundles
  (`gmail-axi.mjs`, `google-axi.mjs`, `sessions-axi.mjs`) touched only by
  `build:cli`'s git-describe VERSION stamp were reverted so the diff stays
  scoped to kitchen.

## Follow-ups

- Issue [#172](https://github.com/JarvusInnovations/claude-assist/issues/172)
  — wire stated-weight consumption into the free-text event resolver
  (`POST /inventory/events`), so a remark like "ate 100g of the hummus"
  routes here instead of falling through to opened/finished/tossed/recount
  matching or going unmatched. Needs its own parsing-policy decisions
  (consumption vs. correction phrasing, grams vs. fraction extraction,
  confidence threshold), deliberately out of this plan's scope.
