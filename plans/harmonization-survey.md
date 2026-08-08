---
status: in-progress
depends: []
specs: []
issues: []
---

# Plan: Survey divergences against the reference agent runtime

## Scope

The survey half of a survey-then-adopt effort. Compare this repo's
model-invocation, background-work, and escalation code against a sibling
agent-runtime service (private, same authors, built later, different deployment
substrate) and write the comparison down with an adopt-or-skip decision and a
reason for every item.

The inventory is a **deliverable, not a preamble**: the value of the survey is
as much in what was deliberately not adopted as in what was, and that half is
lost the moment it lives only in a reviewer's head.

**Out of scope**: any code change. The adoptions this survey authorizes are
carried by `model-invoker`, `work-leases`, and `approvals`.

## Implements

Nothing in `specs/` directly — this is the input that produced
`specs/modules/invoker.md`, `specs/modules/approvals.md`, and
`specs/behaviors/scheduled-work-leases.md`.

## Approach

- Read both runtimes' model-call, queue, and escalation code end to end.
- Classify each divergence: adopt, adopt-with-the-reference's-gap-fixed, or skip.
- Skips must name the substrate difference or the missing payoff that justifies
  them — "we didn't get to it" is a follow-up, not a skip.
- Record the axes where this repo is already *ahead* as invariants to preserve,
  so a later refactor doesn't quietly regress them.

## Validation

- [x] `docs/runtime-divergence-inventory.md` exists with an adopt/skip decision
      and rationale per item.
- [x] Every skip names its reason (substrate difference, no payoff, or already
      equivalent).
- [x] Gaps in the reference implementation are called out where the adoption
      fixes them rather than copying them.
- [x] The inventory names no private system, host, person, or client — it is
      readable by anyone who finds this public repo.

## Risks / unknowns

- **Scope creep** — "harmonize" sprawls without a bound. The survey is the
  bound: what isn't in the inventory doesn't get built in this pass.
- **Substrate mismatch** — the reference runs a horizontally-scaled worker
  fleet; this runs one host process. Several of its best patterns exist only to
  survive that difference. Adapt, don't copy.

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
