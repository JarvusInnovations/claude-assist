---
status: done
depends: []
specs:
  - specs/behaviors/session-detail-page.md
issues: []
pr: 252
---

# Plan: Session detail tab hash and Jump to Latest

## Scope

1. Tab state in the URL hash (`#outline`, `#transcript`, `#tools`, `#files`),
   replacing history on change and opening from the hash on load.
2. A floating "Jump to latest · <relative time>" button on the transcript tab,
   visible while the transcript's end is out of view, with the absolute time
   on hover.

## Implements

- **specs/behaviors/session-detail-page.md**: tabs and Jump to Latest (the
  transcript tail behavior shipped in #250).

## Approach

Controlled Radix `Tabs` value derived from `location.hash`, written back with
`history.replaceState`. The button observes a sentinel after the transcript
end with `IntersectionObserver`, and scrolls it into view on click.
`date-fns` `formatDistanceToNowStrict` renders the relative time.

## Validation

- [x] Reloading on each tab stays on that tab; an unknown hash opens Outline
- [x] The button shows only while the end is out of view, jumps to the end, and
  shows `ended_at` as relative plus absolute time
- [x] Admin build is clean

## Notes

Verified in a browser against a live ~500 MB session: hash-driven tabs (reload stays, no history growth, unknown hash falls back to Outline) and the Jump to Latest button (appears when the end is out of view, scrolls to it, then hides). The admin type-check has 3 errors on main, unrelated.

## Follow-ups

None.
