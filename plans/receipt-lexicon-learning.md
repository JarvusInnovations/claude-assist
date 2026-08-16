---
status: planned
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

- [ ] A line resolved via `recount --product-ulid` produces a lexicon mapping;
      a second receipt carrying that line matches automatically.
- [ ] A bare store name and the full printed header resolve to the SAME store,
      while a similarly-worded but unrelated store resolves to a DIFFERENT one.
- [ ] A resolved store string is stored, and a second receipt carrying it makes
      no model call.
- [ ] The migration re-keys existing spellings onto resolved stores without
      losing a product mapping or a skip marker.
- [ ] Re-attaching a different product to the same line overwrites the mapping
      rather than adding a second.
- [ ] `--unlink-product` leaves no mapping asserting the removed link.
- [ ] A skip marker still wins over a stale product mapping, and vice versa
      (last write wins, unchanged).
- [ ] Retro-resolution of pending `needs_info` siblings still fires on a
      learned mapping, not only on a curated one.

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

*Populated at closeout.*

## Follow-ups

*Populated at closeout.*
