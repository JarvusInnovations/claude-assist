---
status: planned
depends: []
specs:
  - specs/behaviors/session-transcript-storage.md
issues: []
---

# Plan: Transcript read layer

## Scope

Route every reader of transcript content through one range-based read API
before storage changes shape, so the switch to chunks is a change inside one
module rather than across nine call sites.

In scope:

1. A `TranscriptReader` with range operations: full, message range
   (`fromSeq`/`toSeq`), head+tail within a byte budget, window around an anchor
   uuid, and a streaming line iterator for grep.
2. Implemented over today's `sessions.raw_transcript`. Head/tail and byte ranges
   use SQL `left`/`right`/`substring`, so the server never loads a whole large
   value to return part of it.
3. Migrate every reader: the transcript, grep, around and cross-session
   transcript routes; share routes; the classification store/service
   (`serializeSince`); the outline fetch; the reparse scripts.

Out of scope: any change to what is stored.

## Implements

- **specs/behaviors/session-transcript-storage.md**: "Readers take ranges".

## Approach

Introduce the reader in `packages/sessions`. Convert one caller at a time with
before/after output equality tests on fixture transcripts. After the plan, a
grep for `raw_transcript` outside the reader and the ingest writer returns
nothing.

## Validation

- [ ] No SELECT of `raw_transcript` outside the read layer and the ingest writer
- [ ] Route and pipeline outputs are byte-identical before and after on fixtures
- [ ] Around-anchor and grep on the largest archived session stay under a
  memory ceiling (measured) instead of loading the full value

## Risks / unknowns

- Around-anchor needs uuid → message index. Today that is a scan. With chunks
  it needs either a per-message index or a scan bounded to candidate chunks
  (open question on the planning PR).
