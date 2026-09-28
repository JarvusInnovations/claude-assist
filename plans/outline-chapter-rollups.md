---
status: planned
depends: []
specs:
  - specs/behaviors/session-outlines.md
issues: []
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

- [ ] Unit: grouping is deterministic, and only closed, resolved children
  roll up
- [ ] Unit: compose inputs stay ≤ ~fanin per level for 10, 100, 1,000 and
  10,000 windows
- [ ] Unit: each rollup is summarized exactly once; a failed rollup retries up
  to the cap
- [ ] Integration (throwaway Postgres): the migration applies; a session with
  hundreds of windows composes within the budget across sweeps
- [ ] Deployed: the stuck multi-week session gets a fresh composed outline
  after its attempts are reset
