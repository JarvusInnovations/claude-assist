---
status: in-progress
depends: [session-timeline-time-scale]
specs:
  - specs/behaviors/session-context-window.md
issues: []
---

# Plan: Context timeline, two views

## Scope

In use, Condensed and Ruler differed only by the calendar strip, so they
merge into **Active time** (condensed axis plus strip, the default), alongside
**Calendar time**. Labels are "Active" and "Calendar", with full-name
tooltips. A remembered "condensed" or "ruler" maps to Active.

## Implements

- **specs/behaviors/session-context-window.md**: Two views.

## Validation

- [x] Admin build, type-check (no new errors) and layout tests pass
- [x] Server-rendered check: default and legacy stored values open Active with
  the strip; Calendar unchanged; two buttons; no NaN
