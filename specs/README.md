# Specs

Declarative specifications for claude-assist's generic modules — what *should
be true* of each module's API, data, and behavior, written instance-agnostic
(claude-assist is a public toolkit; instance data and instance names never
appear here). Follows the specops methodology (spec leads, code conforms).

- `modules/` — one file per service module (capture, kitchen, …). New modules
  start here; existing modules are back-specced opportunistically when touched.
- `behaviors/` — cross-cutting rules that hold across modules and belong to the
  host rather than to any one of them (e.g. how an unmatched route responds).
