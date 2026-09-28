# Behavior: Session detail page (admin)

## Rule

The admin session detail page (`/sessions/:id`) keeps the reader oriented in
long sessions.

- **Tabs live in the URL hash.** The page has four tabs: `#outline`,
  `#transcript`, `#tools` and `#files`. Selecting a tab updates the hash
  (replacing history, not pushing), and loading the page with a hash opens that
  tab. No hash or an unknown hash opens `#outline`. Reloading therefore stays on
  the same tab, and a tab can be linked directly.
- **Jump to Latest.** On the transcript tab, a floating button sits at the
  bottom corner of the viewport while the end of the transcript is out of view.
  It scrolls to the end and reads "Jump to latest · <when>", where `<when>` is
  the session's last activity (`ended_at`) shown as a relative time ("3m ago",
  "2d ago") with the absolute local time on hover. It hides once the end of the
  transcript is in view.
- **The transcript shows the latest.** For a session whose serialized
  transcript exceeds the size cap, the tab shows the most recent portion, with a
  marker at the top saying earlier content was truncated
  (specs/behaviors/session-transcript-storage.md, readers).

## Applies To

- `apps/admin` session detail page and its transcript viewer.

## Principles

**Local** — the latest is what a reader of a live session came for. Where an
oversized view must drop content, it drops the oldest; where the reader might
be far from the end, a single action takes them there and says how fresh
"there" is.
