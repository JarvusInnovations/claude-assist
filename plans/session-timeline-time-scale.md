---
status: in-progress
depends: [session-context-timeline]
specs:
  - specs/behaviors/session-context-window.md
issues: []
---

# Plan: Context timeline time-scale views

## Scope

Chosen from a mockup comparison of six options on three real sessions: B as
the default, E and F as alternate views.

1. Condensed (default): gap width grows with log(duration); graded gap
   shading in four steps; bold labels for gaps of a day or more.
2. Ruler: Condensed plus a true-time strip with connectors.
3. Calendar: true-time x-axis, shaded idle periods, line broken across idles,
   adaptive ticks.
4. A three-way view switch in the chart header, remembered in `localStorage`
   (read and written in try/catch; defaults to Condensed).

## Implements

- **specs/behaviors/session-context-window.md**: Timeline, axis and views.

## Approach

Pure geometry in `apps/admin/src/lib/timeline-layout.ts` (log gap weight,
shade bucket, calendar scale and ticks), unit-tested. `ContextTimeline.tsx`
renders the three views from it. No backend change; the endpoint already
returns segments with gap durations.

## Validation

- [ ] Layout tests: gap width increases with duration, shade buckets at their
  thresholds, calendar scale maps the ends of the span to the plot edges
- [ ] Admin build and type-check add no new errors
- [ ] Deployed: the three views render on a one-day, a month-long, and a
  multi-week bot session
