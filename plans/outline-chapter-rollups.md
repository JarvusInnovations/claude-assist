---
status: done
depends: []
specs:
  - specs/behaviors/session-outlines.md
issues: []
pr: 257
---

# Plan: Chapter rollups for windowed outlines

## Scope

A long windowed session's compose call fails (`invalid_request`) once its
window summaries exceed the model's input. The largest session has more than
800 windows, has failed its attempt cap, and stopped being retried. Add a
summary hierarchy so the compose input stays bounded.

1. Migration 020 (schema only, fast; see ca#248): `sessions.outline_rollups`
   (session, level, index, child range, seq/time span, status, summary,
   content_hash, model, attempts, lease columns, closed-by-construction).
2. Rollup planning and summarization in the windowed pass, after window
   summarization: carve level-1 groups from closed windows, level-n from
   closed level-(n-1), claim and summarize under the shared per-sweep budget,
   with the same lease/attempt semantics as windows.
3. Compose from top-level rollups, ungrouped lower-level rollups, and loose
   windows. The compose signature covers all of them.
4. Config `SESSIONS_OUTLINE_ROLLUP_FANIN` (default 40), wired like the window
   settings.
5. `GET /sessions/:id` and `sessions-axi details` expose rollups alongside
   windows (additive).

## Implements

- **specs/behaviors/session-outlines.md**: Rollups; the composition changes.

## Validation

- [x] Unit: grouping is deterministic, and only closed, resolved children
  roll up
- [x] Unit: compose inputs stay ≤ ~fanin per level for 10, 100, 1,000 and
  10,000 windows
- [x] Unit: each rollup is summarized exactly once; a failed rollup retries up
  to the cap
- [x] Integration (throwaway Postgres): the migration applies; a session with
  hundreds of windows composes within the budget across sweeps
- [ ] Deployed: the stuck multi-week session gets a fresh composed outline
  after its attempts are reset

## Notes

- Rollups are closed-by-construction (a row is only inserted once every
  child in its range is resolved), so unlike `outline_windows` there's no
  open-tail/mutability case — `OutlineRollupStore` is simpler than
  `OutlineWindowStore` (no `releaseUnchanged`), even though it shares the
  same claim/lease/attempt-cap shape.
- `planRollupGroups` judges each fan-in-sized group independently by its own
  index range rather than assuming in-order resolution, so a later group can
  become ready before an earlier one — correct under a second process's
  sweep racing the scheduled one, not just the common oldest-first case.
- A window (or rollup) already grouped into a chapter is excluded from the
  compose call the moment the chapter *row* exists, even before that
  chapter itself has been summarized. Under a tight per-sweep budget this
  can produce a transient dip in composed content (a chapter's windows
  disappear from compose until the chapter resolves) before catching back
  up. `caughtUp` correctly reflects this — `outline_hash` never falsely
  advances while a chapter is still pending — so nothing is lost, only
  delayed a sweep or two. Documented here rather than in the spec since it's
  an implementation trade-off, not a governing rule.
- Integration testing (`outline-rollups.integration.test.ts`) writes the
  session row and transcript chunk directly with raw SQL rather than through
  `SyncService`, for exact control over message/window counts without
  incremental-parser timing details muddying the picture.
- Migration 020 applies in well under a second against a fresh `postgres:18`
  (verified locally alongside migrations 001–019) — no backfill risk for
  ca#248's plugin-startup timeout.

## Follow-ups

- The "Deployed" validation criterion (resetting the previously-stuck
  multi-week session's `outline_attempts` and confirming it composes
  cleanly in production) is for the orchestrator/deploy step to close out
  after this PR merges and ships — not verifiable from a worktree.
