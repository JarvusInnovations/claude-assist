---
status: done
depends: []
specs:
  - specs/behaviors/session-context-window.md
issues: []
pr: 271
---

# Plan: chunked ingest records the context limit

## Scope

Chunked ingest (live since 2026-09-24) writes a session's context readings
and model but never `context_limit_tokens`. Only the retired full-transcript
parser resolved it. Every session first ingested since then has a null limit,
so the sessions list shows no context bar and the detail page shows no
percentage or graph scale. That was 50 sessions when this plan was written.

In scope:

- `writeIngestCycle` sets `context_limit_tokens` from the context model on
  both insert and update.
- A reconcile task (on startup, then daily) sets every row's limit to
  `contextWindowFor(context_model)`. It repairs the affected rows, and it
  makes a model added to the limit table apply to sessions already stored.

Out of scope:

- Changes to the limit table itself. Every model in the affected rows is
  already listed.

## Implements

- `specs/behaviors/session-context-window.md` § Model → limit resolution —
  the stored limit always equals the table's value for the recorded model,
  whatever the ingest path, including after the table changes.

## Approach

- `chunk-store.ts`: resolve `contextWindowFor(a.contextModel)` in the
  session row's INSERT and UPDATE. Add `reconcileContextLimits(sql)`, which
  runs one UPDATE per distinct model and skips rows that are already correct.
- `index.ts`: register `sessions:reconcile-context-limits`, run on startup
  and daily.

## Validation

- [x] Unit: the INSERT and UPDATE both carry the resolved limit.
- [x] Integration (real Postgres): a chunk-ingested session on
      `claude-opus-5-5` stores a 1,000,000 limit. After its limit is nulled,
      reconcile restores it, and a second reconcile changes nothing.
- [ ] Deployed: after restart, no session with a known model has a null
      limit, and the context bars render on `/sessions`.

## Risks / unknowns

- If a model is ever removed from the table, reconcile sets its sessions'
  limits to null. That matches the spec's rule against guessed limits.

## Notes

- The deployed check runs after merge, since the live server restarts from
  `main`. Its result is recorded as a comment on PR #271.
- Removing the limit write from the INSERT makes the integration test fail
  (`Expected: 1000000, Received: null`).
- This regression came in when chunked ingest replaced the full parser.
  Every derived column the old parser wrote needs a counterpart in
  `writeIngestCycle`. `context_limit_tokens` was the one that got dropped.

## Follow-ups

- None.
