---
status: done
depends: [receipt-lexicon-learning]
specs:
  - specs/modules/kitchen.md
issues: []
---

# Plan: ranked candidates for near-miss receipt lines

## Scope

For a line that does not match exactly, compute ranked candidate products and
expose them so a caller can offer a pick instead of demanding a fresh label scan.

- **Scoring** over three independent signals: line-text similarity against known
  lines for the canonical store, product name/alias similarity, and price
  proximity to that product's own price history at that store.
- **No auto-attach at any score.** An exact lexicon hit remains the only
  automatic attachment — it replays a human decision rather than making one.
  Everything else stays `needs_info` and exposes its ranked candidates.
- **Read API**: candidates for an unmatched line, computed on demand.
- **Capture-app picker**: surface candidates on an unmatched line with a
  "none of these — scan new item" escape.

**Out of scope**: learning and store normalization (`receipt-lexicon-learning`,
which this depends on). Building the picker before those would have it
re-answering questions the system already knew.

## Implements

- **specs/modules/kitchen.md § Near-miss candidates** — scoring, thresholds, the
  read-not-state rule.

## Approach

**Sequenced deliberately behind the learning plan.** The line that prompted this
was an exact repeat the lexicon should already have known — a picker would have
"solved" it by asking a question that should never have been asked. Fixing the
memory first means the picker only ever sees genuinely novel or varied lines,
which is also the only way to tell whether its ranking is any good.

**Price corroborates, never decides.** Prices move and sales exist, so price can
only break ties among textually plausible candidates. A candidate the text does
not support must never be promoted by price alone — that is how a sibling SKU at
the same price gets silently substituted.

**Candidates are computed, never stored.** A stored list goes stale the moment a
product or price changes, and once written down is indistinguishable from a
decision.

**The escape hatch is a first-class outcome, not a fallback.** "None of these"
must be as fast as picking, or the picker becomes pressure to accept a wrong
match — which is worse than the scan it was meant to save.

## Validation

- [x] A re-worded line for a familiar product ranks that product first.
- [x] No path attaches a product from a score — the module exposes no threshold
      and no attach verb; the only automatic attachment remains an exact lexicon hit.
- [x] Two unrelated products at the same price do not rank each other; price
      scales only what text already found, so a zero-text candidate stays zero.
- [x] Every non-exact line lands `needs_info` — unchanged; candidates are an
      additional read, not a change to resolution.
- [x] Candidates recompute on every call — nothing is stored.
- [x] Choosing a candidate goes through `recount --product-ulid`, which teaches
      the lexicon, so the same line matches exactly next time.
- [~] "None of these" is reachable in one action. **API-side only** — the CLI
      simply does not attach, which is the correct no-op. The APP affordance is
      not built (see Follow-ups).

## Risks / unknowns

- **Ranking quality is now a UX concern, not a correctness one.** With no
  auto-attach, a bad ranking costs a scroll rather than a corrupted panel. That
  lowers the stakes enough to ship without tuning data — which the threshold
  design could not do.
- **Similarity on abbreviated receipt text is hard.** Store lines are truncated
  and inconsistently abbreviated; token overlap may perform poorly on exactly the
  short lines that need it most.
- **Unknown how often near-misses actually occur** once learning is fixed. If
  the answer is "rarely", the picker is low-value and this plan should shrink to
  the read API without a UI.

## Notes

**The scoring module contains no threshold, deliberately.** Removing auto-attach
turned ranking quality from a correctness property into a UX one, which is what
made this shippable without tuning data — the earlier threshold design could not
have been.

**Character trigrams over tokens.** Receipt lines are truncated and
abbreviation-heavy, where token overlap performs worst exactly when it is needed
most. Dice over trigrams handles the abbreviated-vs-spelled-out case that
motivated the plan.

**Price scales; it never adds.** The combined score multiplies the text score by
a factor in 0.9–1.1, so a candidate with no textual support cannot be promoted
however well its price agrees. Two unrelated items at one price say nothing, and
a test pins that.

**A missing price reports `null`, never `0`.** Zero would read as disagreement
rather than absence, and the CLI prints `n/a` for the same reason.

**A known line for this store outweighs a catalog name** (×1.15), because it is
evidence about how THIS store prints THIS product rather than about what the
product is called.

## Follow-ups

- **Issue** — the capture-app picker is not built. The API returns ranked
  candidates with per-signal breakdown; the app affordance (list + "none of
  these — scan it") is a client change requiring an app build to install.
- **Unknown, worth measuring before investing in the UI** — how often near-misses
  actually occur now that learning and store resolution are fixed. If the answer
  is "rarely", the API alone may be sufficient and the picker not worth building.
