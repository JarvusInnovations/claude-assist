---
status: planned
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
- **Threshold policy**: auto-attach above a high-confidence bar; below it, leave
  the item `needs_info` exactly as today and expose the ranked candidates.
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

- [ ] A re-worded line for a familiar product ranks that product first.
- [ ] A genuinely new SKU in a familiar category returns candidates but none
      above the auto-attach threshold.
- [ ] Two unrelated products at the same price do not rank each other; price
      alone never promotes a textually implausible candidate.
- [ ] Below threshold, the item still lands `needs_info` — behavior unchanged
      from today for anything the module is not confident about.
- [ ] Candidates recompute after a price or catalog change rather than serving a
      stale set.
- [ ] Choosing a candidate teaches the lexicon (via `receipt-lexicon-learning`),
      so the same line matches exactly next time.
- [ ] "None of these" is reachable in one action and leaves the item in exactly
      the state it would have been without the picker.

## Risks / unknowns

- **Thresholds cannot be tuned without data.** Ship with a conservative bar and
  the expectation of revisiting it; too low silently corrupts panels, prices and
  (since eaten sheets decrement) stock.
- **Similarity on abbreviated receipt text is hard.** Store lines are truncated
  and inconsistently abbreviated; token overlap may perform poorly on exactly the
  short lines that need it most.
- **Unknown how often near-misses actually occur** once learning is fixed. If
  the answer is "rarely", the picker is low-value and this plan should shrink to
  the read API without a UI.

## Notes

*Populated at closeout.*

## Follow-ups

*Populated at closeout.*
