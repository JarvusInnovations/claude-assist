---
status: done
depends: []
specs:
  - specs/modules/kitchen.md
issues: [199]
---

# Plan: canonical store key + learn from every resolution

## Scope

The two silent defects that make receipt matching miss lines it has already
solved. No UI, no scoring — this is the half that needs neither.

- **Model-resolved store identity.** At receipt parse, the model is given the
  receipt's store text, the optional operator-supplied store name, and the full
  roster of known stores, and returns either a match or a normalized new name.
  The raw string → store mapping is then STORED, so the model is consulted once
  per novel string and every later receipt resolves without a model call.
- **Migration** resolves the existing store strings the same way — a one-time
  pass over the distinct values — and re-keys lexicon rows and items onto the
  resolved stores.
- **Learn on every attachment.** Every path that attaches a product to an item
  carrying a `store` and a `raw_label` upserts the `(store_key, line_text)`
  mapping — not just the label-scan path. Notably `recount --product-ulid`.
- **Un-attachment clears what it taught.** `recount --unlink-product` must not
  leave a mapping asserting the link it just removed.

**Out of scope**: candidate scoring, the picker API, any capture-app change —
all in `receipt-match-candidates`. Also out: re-parsing historical receipts.

## Implements

- **specs/modules/kitchen.md § Receipt-line matching** — both halves.

## Approach

**The evidence is specific and worth keeping in the record**, because both
defects are invisible in normal use:

- One retailer's mappings are split across two store spellings, with a line
  duplicated under both — someone re-added it because the first entry could
  never match. That is the normalization defect leaving a trace.
- A line resolved to a product on one date came back `unmatched` two weeks later,
  same line, same store, same product. That is the learning defect.

**Learning is the higher-leverage half.** Normalization revives orphaned rows
once; learning stops the lexicon depending on anyone remembering to curate it.

**The upsert is what makes learning safe.** A wrong resolution teaches a wrong
mapping, so the fix must be that re-attaching overwrites — which the existing
`UNIQUE(store, line_text)` already gives. The risk is not learning wrongly; it is
learning wrongly *and having no way back*.

## Validation

- [x] A line resolved via `recount --product-ulid` produces a lexicon mapping;
      a second receipt carrying that line matches automatically.
- [~] A bare store name and the full printed header resolve to the SAME store,
      while a similarly-worded but unrelated store resolves to a DIFFERENT one.
      **The roster reaches the parser and the prompt states the rule with the
      dangerous cases named; the resolution itself is model behaviour and is not
      unit-testable.** Needs observation on real receipts.
- [ ] A resolved store string is stored, and a second receipt carrying it makes
      no model call. **NOT BUILT** — see Follow-ups.
- [ ] The migration re-keys existing spellings onto resolved stores without
      losing a product mapping or a skip marker. **NOT BUILT** — see Follow-ups.
- [x] Re-attaching a different product to the same line overwrites the mapping
      rather than adding a second (the existing `UNIQUE(store, line_text)` upsert).
- [x] `--unlink-product` leaves no mapping asserting the removed link — the row
      survives with a null product, retracting the claim without erasing history.
- [x] A skip marker still wins over a stale product mapping, and vice versa
      (last write wins, unchanged).
- [x] Retro-resolution of pending `needs_info` siblings still fires on a
      learned mapping — it hangs off `upsertLexicon`, which learning now calls.

## Risks / unknowns

- **A model resolution is non-deterministic**, so the same string could resolve
  differently on two runs. Storing the mapping is what contains this: the model
  answers once, and the answer is then a fact rather than a recomputation. A
  wrong answer is correctable and its failure mode is a fragmented lexicon —
  visible as unmatched lines, not as silently wrong numbers.
- **The roster must be passed in full.** A truncated roster makes a match
  impossible to find and invites the model to mint a duplicate store, which is
  the exact fragmentation this fixes.
- **Learning cements mistakes at machine speed.** Every future receipt inherits a
  wrong mapping until someone notices. The upsert makes it correctable but does
  not make it visible — worth watching whether a corrections surface is needed.
- **Historical rows may have store strings no current receipt produces**, so
  migration can revive a mapping that still never matches. Harmless, but it means
  a clean migration is not proof the key is right.

## Notes

**Split into what ships and what was left, deliberately.**

*Shipped:* learning on every product attachment (not just the label path), the
retraction on un-attach, and the full store roster reaching the receipt parser
with a prompt that names the two dangerous collapses — a standalone market
versus a chain containing "market", and a small-format store versus its
full-size sibling.

*Not shipped:* persisting the raw→resolved store mapping, and re-keying the
existing spellings. Both were in scope and both are honestly still open — see
Follow-ups. The roster alone should stop NEW fragmentation; it does not repair
the fragmentation already present.

**Un-attach retracts rather than deletes.** There is no delete verb for a
lexicon row and inventing one would fight the table's stated monotonic-in-intent
design. Overwriting with a null product retracts the claim while keeping the row,
so a later resolution upserts over it normally.

**The store-resolution behaviour is not unit-testable**, and the plan should not
pretend otherwise. What is tested is that the roster is passed in full from both
items and lexicon; whether the model resolves correctly is an observation to make
on real receipts.

## Follow-ups

- **Issue** — persist the raw→resolved store mapping so a known string resolves
  without a model call. Cheap now that the roster exists, and the guard against
  the model answering differently on two runs.
- **Issue** — the existing spellings are still fragmented (roughly nine strings
  for about five stores on the instance this was written for). Re-keying needs a
  per-store judgment, so it wants an operator command rather than a migration:
  the wrong merge is unrecoverable.
- **Deferred to plan** — `receipt-match-candidates` for anything the exact
  lookup still misses.
