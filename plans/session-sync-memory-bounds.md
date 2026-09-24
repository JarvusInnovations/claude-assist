---
status: in-progress
depends: []
specs:
  - specs/behaviors/session-sync-memory-bounds.md
issues: []
---

# Plan: Contain session-sync memory

## Scope

A single very large, still-growing transcript (hundreds of MB, from a
long-running automated session) drove the server to many GB of resident
memory plus swap on every sync cycle. Each cycle read it whole, parsed it,
built a multi-hundred-MB row, and then failed the `tool_calls` insert on
Postgres's bind-parameter limit. The session row was never consistently
archived, and because the file keeps growing its hash never matches, so the
same work repeated every five minutes.

In scope (containment):

1. `SESSIONS_MAX_FILE_SIZE` (default 128 MiB). The scanner stat-checks every
   transcript before reading it and records oversized ones. Sync logs a
   warning for each; the push CLI prints them.
2. Hash-before-parse ordering in discovery, so the ignore-marker check never
   parses an unchanged transcript.
3. The session row write and the `tool_calls` index write run in one
   transaction.
4. The `tool_calls` insert is batched at 5,000 rows (35,000 parameters).
5. `MemoryHigh` / `MemoryMax` / `MemorySwapMax` in the shipped systemd unit.

Out of scope: streaming hash/parse, and not holding every changed session's
content at once during discovery. See Follow-ups.

## Implements

- **specs/behaviors/session-sync-memory-bounds.md**: the whole spec.

## Validation

- [x] Scanner unit tests: oversized transcripts are skipped by discovery,
  inventory and by-id loading; the oversized report resets per scan; the
  default limit admits normal transcripts
- [x] Existing sessions tests pass; workspace build is clean
- [ ] Deployed: warning logged for the oversized session, and no multi-GB spike
  across several sync cycles
- [ ] Deployed: the unit's memory limits are in effect
  (`systemctl --user show -p MemoryMax`)

## Follow-ups

- Stream transcript hashing and discovery so changed sessions aren't held in
  memory together, and the size limit can rise.
- Ingest oversized sessions in a bounded form (metadata and tool-call index
  without `raw_transcript`) instead of skipping them outright.
