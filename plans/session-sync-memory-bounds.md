---
status: done
depends: []
specs:
  - specs/behaviors/session-sync-memory-bounds.md
issues: []
pr: 237
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
6. Folded in from an earlier unshipped branch: discovery yields sessions one
   at a time instead of buffering the changed set, the push inventory hashes
   by stream, and the outline sweep stops loading every `raw_transcript` at
   once.

Out of scope: incremental (append-only, chunked) transcript storage, which
removes the need to re-read and rewrite a growing transcript whole. See
Follow-ups.

## Implements

- **specs/behaviors/session-sync-memory-bounds.md**: the whole spec.

## Validation

- [x] Scanner unit tests: oversized transcripts are skipped by discovery,
  inventory and by-id loading; the oversized report resets per scan; the
  default limit admits normal transcripts
- [x] Existing sessions tests pass; workspace build is clean
- [x] Deployed: warning logged for the oversized session, and no multi-GB spike
  across several sync cycles
- [x] Deployed: the unit's memory limits are in effect
  (`systemctl --user show -p MemoryMax`)

## Follow-ups

- Chunked, incrementally ingested transcript storage (its own spec + plan),
  after which the size limit becomes a per-cycle ingest budget.
- Ingest oversized sessions in a bounded form (metadata and tool-call index
  without `raw_transcript`) instead of skipping them outright.

## Notes

**Operator verification (deployed).** Every sync cycle logged the size-limit
warning for the oversized session. Across two observed 5-minute cycles, peaks
fell from about 8 GB RSS plus about 8 GB swap to 2.0–3.1 GB (page cache
included), with cycles finishing in about 35 s instead of stalling the event
loop for minutes. `MemoryHigh`/`MemoryMax`/`MemorySwapMax` were confirmed in the
live cgroup after `daemon-reload`. Superseded by chunked ingest, which retired
the size skip; see [transcript-chunked-ingest](transcript-chunked-ingest.md).
