---
status: planned
depends: []
specs:
  - specs/modules/kitchen.md
issues: []
---

# Plan: `notes_reviewed` — make an un-costed human note visible instead of silent

## Scope

A cook-mode submission's free-text note routinely names something the computed panel
does not account for. The note is preserved, so the record is honest; the totals
silently are not. This makes the gap visible and reconcilable after the fact.

- Migration: `notes_reviewed boolean not null default false` on entries.
- An entry **with** a human-supplied note (submission note, or `log`/`patch` `--note`)
  is unreviewed. An entry with no note is not unreviewed — there is nothing to review.
- `GET /entries/questions` (and `kitchen-axi entries questions`) — unreviewed-note
  entries, mirroring the existing needs-info surface for inventory.
- The **home view's open-question count includes them**.
- `entries review <ulid>` marks reviewed. Correcting the panel stays a separate
  `patch`.

**Out of scope**: any structured "extras" input on the worksheet — rejected on
purpose, see § Approach.

## Implements

- **specs/modules/kitchen.md § Unreviewed entry notes** — the whole section.

## Approach

**The rejected design is load-bearing context.** The obvious fix is an extras row on
the sheet: name it, weigh it, cost it. It would be ignored — nobody reaching for a
condiment stops to weigh it — and the silent gap would persist *behind a feature that
looks like it closed it*, which is worse than the gap alone.

So don't try to prevent the omission; surface it. The eater is not taxed at eat time,
and reconciliation happens whenever someone is next in the ledger. That is the same
trade cook mode itself makes, and the reason its loop closes at all.

**Reuse the existing vocabulary rather than inventing one.** Inventory already has
`needs_info` + `questions` for "a human said something the ledger hasn't reconciled."
This is that same idea on entries, so it costs no new concept and lands in a surface
sessions already read.

**Reviewing ≠ correcting.** Most extras are immaterial; the honest outcome is usually
"seen, costs nothing." Conflating the two would push toward pointless panel edits to
clear a flag.

## Validation

- [ ] A cook-mode submission carrying a note produces an entry with
      `notes_reviewed = false`; one with no note does not appear in questions.
- [ ] `entries questions` lists exactly the unreviewed-note entries, oldest first.
- [ ] The home view's open-question count is the sum of needs-info items and
      unreviewed-note entries, and is non-zero on a fresh invocation after such a
      submission.
- [ ] `entries review <ulid>` clears the flag without touching any macro field,
      `source`, or `status`.
- [ ] `patch --note` on an existing entry re-flags it unreviewed; a macro-only `patch`
      does not.
- [ ] Existing entries backfill to `notes_reviewed = true` — the migration must not
      manufacture a backlog out of history nobody is going to review.

## Risks / unknowns

- **The backfill decision is a judgment call.** Defaulting historical noted entries to
  reviewed keeps the surface actionable; defaulting them to unreviewed would drown the
  count on day one and train everyone to ignore it. Chosen deliberately, recorded here
  because it is not obviously right.
- **Note provenance needs care**: an agent-written note is not a human statement. Only
  human-supplied notes should flag, or the surface fills with the system's own prose.

## Notes

*Populated at closeout.*

## Follow-ups

*Populated at closeout.*
