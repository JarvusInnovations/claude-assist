# Module: Approvals

A generic **human-approval escalation path**: any module can record that
something needs a person, get a notification in front of that person, and carry
on. The module knows nothing about *what* is being approved — kind, title, body,
and an arbitrary JSON payload are caller data.

## The rule that shapes everything else

**No code path ever blocks waiting for a human.** `request()` writes a row,
dispatches a notification, and returns immediately with an id and a status. The
caller then does one of two things: fail the current unit of work with a
transient error and let its normal retry bring it back later, or record the id
and move on. Nothing awaits, nothing polls in a loop, nothing holds a lease, a
connection, or a concurrency slot while a person decides.

This is the difference between an approval gate and a deadlock. A worker that
waits for approval is a worker that is unavailable for every *other* piece of
work in the meantime — and on a single-process instance, that is the whole
system.

## Data model

One table (schema `approvals`, migration `001-approvals.sql`), one row per
request:

- **`kind`** — caller-defined class (`model_budget_overage`, …). Used for
  filtering and for the resolve API's shape checks.
- **`requested_by`** — the module or task that raised it.
- **`title`** / **`body`** — what a human reads in the notification.
- **`payload`** — arbitrary JSON the requester needs back at resolve time.
- **`status`** — `pending` → `approved` | `denied` | `expired` | `cancelled`.
- **`resolution`** — JSON written at resolve: the decision, an optional note,
  and any decision parameters (an approved overage amount, an answer).
- **`dedupe_key`** — nullable, unique among **pending** rows.
- **`expires_at`**, `created_at`, `resolved_at`, `resolved_by`.

`dedupe_key` is enforced by a partial unique index over pending rows only: the
same key may be raised again once a previous request has been resolved or has
expired, but never twice at once. Without it a sweep that runs every minute and
hits the same wall every minute sends a notification every minute, and the
channel stops being trustworthy inside an hour.

## Expiry

Every request carries an expiry, defaulted by config. A sweep transitions
overdue pending rows to `expired` and dispatches nothing — the point of expiry
is to stop the request from hanging, not to nag.

**Expiry means the answer is no.** A gate whose request expired stays closed.
This is the deliberate direction: an approval that nobody looked at is not
consent, and the cost of a stalled pipeline is recoverable in a way that an
unapproved action is not.

A reference implementation this design was compared against declared an
`expired` state in its schema and never set it anywhere. Pending escalations
could block their work indefinitely with no signal. The sweep exists because
that hole is easy to leave and expensive to find.

## Notification

Requests dispatch through the shared notifier at a caller-chosen priority,
defaulting to `notice`. The body names what is being asked and the payload's
salient numbers. Interrupt priority is reserved for gates that are blocking
something time-sensitive — the earned-interrupt bar applies here exactly as
elsewhere.

## API

```
POST   /api/approvals                  request (also available in-process as fastify.approvals)
GET    /api/approvals?status=pending   list
GET    /api/approvals/:id              read one
POST   /api/approvals/:id/resolve      { decision: 'approved'|'denied', note?, params? }
```

Resolve is transactional and validates state: resolving an already-resolved or
expired request returns **409**, not a silent overwrite. A double-click, a
retried webhook, and two people answering at once all land on the same honest
answer.

In-process, the same surface is `fastify.approvals` — `request`, `get`, `list`,
`resolve`, `findResolved(dedupeKey)`. `findResolved` is how a requester learns,
on a later pass, that its gate has opened, without ever having waited.

## Relationship to existing per-module hold states

Several modules already park work for a person: staged mail actions awaiting
confirm-to-execute, captures held for review, inventory items needing a label.
Those stay where they are. They are **domain workflow states** with their own
review surfaces and their own semantics, not generic yes/no gates, and folding
them into this table would make both worse. This module is for gates that are
genuinely cross-cutting — spend, destructive operations, anything a new module
needs approved without inventing its own status column.

## Principles

**Inherited** — from [principles.md](../principles.md):

- [Never block on a human](../principles.md#never-block-on-a-human) — this
  module is that principle's implementation.
- [Interrupts are earned](../principles.md#interrupts-are-earned)
- [The database is the coordination primitive](../principles.md#the-database-is-the-coordination-primitive) —
  deduplication is a partial unique index, not a remembered flag.
