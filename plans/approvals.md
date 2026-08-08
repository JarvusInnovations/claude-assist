---
status: in-progress
depends: [harmonization-survey]
specs:
  - specs/modules/approvals.md
issues: []
---

# Plan: Human-approval escalation path

## Scope

A generic approvals module: record that something needs a person, notify them,
and return. Its first consumer is the invoker's budget breach, which is a real
gate rather than a demo — money is exactly the case where the honest answer to
"should I keep going" is a human's.

**Out of scope**: the three existing per-module hold states (staged mail actions,
held captures, items needing a label). Those are domain workflow states with
their own review surfaces; the spec says why they stay put.

## Implements

- **specs/modules/approvals.md** — the never-block rule, the data model,
  deduplication, expiry-means-no, the resolve API.
- **specs/principles.md § Never block on a human**.

## Approach

- Contract in `packages/core/src/approvals.ts`, implementation in
  `packages/approvals`, per the contracts-in-core rule.
- Deduplication is a **partial unique index over pending rows**, not a
  remembered flag — a sweep hitting the same wall every minute must not notify
  every minute.
- Notification goes through the existing dispatcher rather than inventing a
  channel. The reference implementation this was compared against notified only
  through a web UI, so a pending gate was invisible unless someone had the page
  open; routing through push fixes that for free.
- An expiry sweep sets `expired`. The reference declared that state and never
  set it anywhere — pending escalations could hang forever. Fixing it is part of
  adopting the pattern, not an extra.
- `findResolved(dedupeKey)` is how a requester learns on a *later* pass that its
  gate opened, without ever having waited.

## Validation

- [ ] `packages/approvals` exists and decorates `fastify.approvals`.
- [ ] `request()` returns without waiting and dispatches a notification.
- [ ] A repeated `dedupeKey` returns the existing pending request instead of
      raising a second one.
- [ ] Resolving an already-resolved or expired request returns 409.
- [ ] The expiry sweep transitions overdue pending rows to `expired`, and an
      expired gate stays closed.
- [ ] The invoker's budget breach raises exactly one approval per window and
      resumes automatically once approved.
- [ ] `bun test` green.

## Risks / unknowns

- **A gate nobody answers stops work** — that is the intended direction for
  spend, but a future consumer might want expiry to mean "proceed". If one
  appears, the default becomes per-kind rather than global; it is deliberately
  not configurable yet.

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
