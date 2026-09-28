---
status: planned
depends: []
specs:
  - specs/behaviors/session-context-window.md
issues: []
---

# Plan: Session context timeline

## Scope

1. Migration: `sessions.context_events` (session_id, seq, ts, kind
   `reading` | `compaction`, tokens, pre_tokens, post_tokens, trigger), indexed
   by (session_id, ts); a per-session marker for timeline backfill coverage.
2. The incremental parser emits readings (the same main-chain,
   `isFirstInChain` rule as `context_final_tokens`) and `compact_boundary`
   compactions. Chunked ingest appends them in the cycle's transaction, and a
   continuity re-ingest replaces them with the chunks.
3. A background backfill for existing sessions: feed chunks through the
   incremental parser one at a time under a per-run byte budget, resumable.
   It must be fast per step so it never stalls startup (see ca#248); migrations
   add only schema.
4. `GET /sessions/:id/context-timeline`: active-time axis segments (gaps over
   30 min collapsed), downsampled readings (≤ ~600, bucket max plus last),
   every compaction, and the limit.
5. Admin chart (inline SVG, no new chart dependency) under the Context Window
   card, full width: token line, limit ceiling when known, compaction markers
   with drop annotation, gap breaks, day labels, hover readout.

## Implements

- **specs/behaviors/session-context-window.md**: the Timeline section.

## Validation

- [ ] Parser test: readings and compactions from split feeds equal those from
  one full feed
- [ ] Ingest appends events without rewriting earlier ones; continuity
  re-ingest replaces them
- [ ] Downsampling keeps the global peak and every compaction; gap collapse and
  day segments unit-tested
- [ ] Backfill covers existing sessions with bounded memory (measured on the
  largest session)
- [ ] Chart renders for a one-day session and a multi-week session
