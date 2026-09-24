---
status: in-progress
depends: [transcript-read-layer]
specs:
  - specs/behaviors/session-transcript-storage.md
  - specs/behaviors/session-outlines.md
issues: []
---

# Plan: Windowed outlines for long-running sessions

## Scope

Today an outline over a long session keeps only the first and last N
characters and drops the middle. For a persistent bot, the middle is most of
the record. Long sessions get **rolling window summaries** instead.

In scope:

1. Sessions over an outline threshold are divided into windows (by message
   range, capped by size or by time span, whichever comes first). Each window
   is summarized once, when complete, and stored with its message range
   (`sessions.outline_windows`).
2. The session outline is composed from the window summaries (summary of
   summaries) and refreshed only when new windows close. The open tail window
   is summarized at most once per sweep.
3. Short sessions keep the current single-pass outline.
4. `sessions-axi` exposes the window summaries in `details`.

## Implements

- **specs/behaviors/session-transcript-storage.md**: truncation is a reader
  choice made over the complete record.
- A new outline behavior spec is written as part of this plan. The windowing
  rule belongs there, not in the storage spec.

## Validation

- [ ] Content from the middle of a multi-week session appears in its outline
- [ ] A closed window is never re-summarized; the model cost per sweep on a
  growing session is bounded by new windows

## Risks / unknowns

- Model cost of the initial backfill of windows for existing long sessions:
  estimate it before running.
