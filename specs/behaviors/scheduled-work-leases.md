# Behavior: Scheduled work runs once — leases and locks

## Rule

Concurrency safety for background work is held in **Postgres**, never in a
process-local variable.

Two mechanisms, applied at two different grains:

1. **Every scheduled task runs under an advisory lock keyed on its name.** A task
   already running — on this host, on another host, or because someone hit the
   manual-trigger route — makes the next attempt a no-op that logs and returns.
2. **Work that is claimed rather than merely swept uses leases.** An atomic
   claim under `FOR UPDATE … SKIP LOCKED`, a lease with an expiry, renewal for
   long work, reclaim of expired leases, an attempt cap, and backoff between
   attempts.

## Why the process-local version is worse than nothing

Before this rule, five pipelines each guarded their sweep with an in-process
flag — an `inProgress` boolean, a `sweeping` boolean, a map of in-flight ids.
Each of those guards has the same two holes:

- **It does not survive a restart.** A deploy or crash mid-sweep leaves rows in
  a running state with no owner, and nothing ever comes back for them. The flag
  that was protecting them died with the process.
- **It is invisible to a second process.** Two hosts, or one host and a manual
  trigger, both pass the guard and both do the work. Where the work is a model
  call, both also pay for it.

The selection queries underneath were plain `SELECT … WHERE status = … AND
attempts < cap LIMIT n` with no row locking, so two concurrent sweeps select the
same rows by construction. The guard made that look safe.

A guard that protects only the single-threaded, never-restarted case protects
exactly the case that was never at risk.

## The lock

Scheduled tasks take a Postgres **advisory** lock, not a row lock: there is no
row to lock, and the thing being serialized is an execution, not a record. The
lock key is derived from the task name, so it is stable across deploys and
requires no table.

`pg_try_advisory_lock` — not the blocking form. A cron task that *waits* for the
previous run stacks up a queue of pending runs behind a slow one and turns a
minute-cadence sweep into an unbounded backlog of connections. Skipping is
correct: the work is still there, and the next tick will take it.

The lock is released in a `finally`, and it is session-scoped, so a crashed
process drops it when its connection closes. There is no stuck-lock recovery
path to write, which is the main reason to prefer advisory locks over a
lock table.

Manual triggers go through the same lock as scheduled runs. A trigger that could
bypass it would be a supported way to double-process.

## The lease

For pipelines that claim rows:

- **Claim** is one statement: select candidates `FOR UPDATE … SKIP LOCKED`, and
  in the same statement set status, owner, lease expiry, and increment attempts.
  Two workers claiming simultaneously get disjoint sets; neither waits.
- **Lease expiry** is a timestamp, not a duration remembered somewhere. Reclaim
  is a sweep: expired leases go back to ready, or to failed once the attempt cap
  is reached, with a structured error recording why.
- **Renewal** exists so the expiry can be short. Without it, safety depends on
  every unit finishing faster than the lease by convention — and the moment one
  doesn't, the row is reclaimed *while still running* and processed twice. A
  reference implementation this pattern was taken from has exactly that hole;
  renewal is the fix, not an embellishment.
- **Backoff.** A failed unit schedules its next attempt rather than becoming
  immediately eligible again. Without it, a deterministically-failing row burns
  its entire attempt budget in milliseconds — and if the failure was a model
  call, it pays for all of them inside a second. The claim query filters on the
  scheduled time.
- **Attempt caps** are terminal but not silent: an exhausted row carries a
  structured error, so "why did this stop" is a query and not an archaeology
  expedition.

### Serializing by key

Where a table has a natural key that must be processed one-at-a-time (all work
for one account, one conversation, one document), the lease helper supports a
**partial unique index over the in-flight statuses**. The database then enforces
at most one active unit per key while `SKIP LOCKED` still gives full parallelism
across different keys. This is applied where a table needs it, not blanket — an
index that never excludes anything is pure cost.

## Applies To

Every scheduled task registered on the host, and every pipeline that claims rows
to process them.

Migration is incremental: the advisory lock is applied to **all** scheduled tasks
at once, because it is transparent to the handler and closes the concurrency hole
everywhere. Lease adoption is per-pipeline and happens as each pipeline is
touched — the lock makes the remaining sweeps safe in the meantime.

## Principles

**Inherited** — from [principles.md](../principles.md):

- [The database is the coordination primitive](../principles.md#the-database-is-the-coordination-primitive)
- [Alert on the absence of success](../principles.md#alert-on-the-absence-of-success) —
  a reclaimed lease and an exhausted attempt cap both leave a queryable record.
