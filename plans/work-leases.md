---
status: in-progress
depends: [harmonization-survey]
specs:
  - specs/behaviors/scheduled-work-leases.md
issues: []
---

# Plan: Advisory-locked scheduled tasks and lease-claimed work

## Scope

Move background-work concurrency safety out of process-local booleans and into
Postgres. Two grains: an advisory lock around every scheduled task, and lease
semantics for pipelines that claim rows.

**Out of scope**: converting all five sweep pipelines to leases in this pass.
One is migrated end-to-end to prove the helper; the advisory lock closes the
concurrency hole for the rest in the meantime, and each converts as it is
touched.

## Implements

- **specs/behaviors/scheduled-work-leases.md** — both mechanisms, the
  `pg_try_advisory_lock` choice, renewal, backoff, and key serialization.

## Approach

- `packages/core/src/locks.ts` — `withAdvisoryLock(sql, key, fn)` over
  `pg_try_advisory_lock`, key hashed from a stable string. Skip-on-contention,
  release in `finally`, session-scoped so a crash self-heals.
- Wire it into the scheduler so **every** registered task is wrapped by default,
  including the manual-trigger route. A task may opt out only with a stated
  reason.
- `packages/core/src/queue.ts` — a lease helper parameterized over an existing
  table (`claim`, `renew`, `complete`, `fail`, `reclaimExpired`) rather than a
  new queue table, because the work already lives in domain tables and moving it
  would be a migration with no payoff.
- Add lease columns to one pipeline's table and convert it, so the helper is
  exercised by a real consumer and not only by its own tests.

## Validation

- [ ] Every scheduled task runs under an advisory lock; a second concurrent run
      (scheduled or manually triggered) is a logged no-op.
- [ ] The lease helper claims with `FOR UPDATE … SKIP LOCKED` and sets owner,
      expiry, and attempt count in one statement.
- [ ] Expired leases are reclaimed to ready, or failed at the attempt cap with a
      structured error.
- [ ] Failure schedules the next attempt with exponential backoff, and the claim
      query respects it.
- [ ] `renew()` extends a lease for long-running work.
- [ ] At least one production pipeline uses the helper.
- [ ] `bun test` green, including concurrency tests that prove two claims are
      disjoint.

## Risks / unknowns

- **Advisory-lock key collisions** — two tasks hashing to the same key would
  serialize against each other. Keys are derived from the full task name and the
  space is 64-bit; a collision is a wrong-but-safe outcome (extra serialization,
  never double execution).
- **A skipped run looks like a broken run** — a task that legitimately overruns
  its interval will log skips every tick. That is information, not noise, but it
  needs to be legible in the logs or someone will chase it.

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
