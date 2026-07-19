---
status: in-progress
depends: [kitchen-module]
specs:
  - specs/modules/kitchen.md
issues: []
pr: 98
---

# Plan: kitchen-axi CLI + assist-kitchen skill

## Scope

Bring the kitchen module up to tooling parity with the older modules
(sessions/gmail/pages): a `kitchen-axi` CLI under `packages/kitchen/src/axi/`
and an `assist-kitchen` skill under `skills/`, built and drift-guarded by the
existing `build:skills` / `check:skills` machinery. Implements the
"Agent tooling" section of `specs/modules/kitchen.md`.

**Out of scope**: any new API surface (the CLI is a veneer over documented
endpoints only), instance installation/wiring (operator concern), and client-app
changes.

## Implements

- **specs/modules/kitchen.md § Agent tooling** — the full command surface,
  home view, output conventions, and the skill's required narrative rules.

## Approach

- Mirror the sessions axi structure: `src/axi/` with a command router, TOON
  table rendering via the shared helpers, `--json` passthrough, home view as
  the bare invocation. Server/auth resolution copied from the sibling CLIs
  (`CLAUDE_ASSIST_SERVER`, bearer token env), no new config surface.
- Multipart `receipts scan` sends the meta part as a form **field** (the
  module's documented part-type rule); photo paths validated client-side
  before posting.
- `skills/assist-kitchen/SKILL.md`: hand-authored narrative carrying the
  spec's decisive write-time rules (multiplier base semantics, override
  terminality, partial-toss fraction meaning, deliberate-vs-classifier
  boundary, ephemeral photos), with generated command-reference regions;
  register splice + CLI-bundle targets in `scripts/build-skill.ts` /
  `scripts/build-cli.ts`.
- Tests per the sibling CLIs' pattern (command parsing, rendering, wire-shape
  pins against the route contracts); `check:skills` green proves bundle
  freshness.

## Validation

- [ ] Bare `kitchen-axi` against a live server prints the home view (today's
      effective totals, pending estimates, eat-first top, question count).
      *(Verified against a mock server: home renders totals + pending + eat-first
      + open-questions in ~1.5KB; live-server confirmation left for the operator.)*
- [x] Every command in the spec's surface exists, hits only documented
      endpoints, and honest-fails (non-zero + message) on 4xx.
      *(All groups routed to `/api/kitchen/*`; validation errors exit 2, HTTP
      4xx surfaces the server's `{error}` message as a non-zero `AxiError`.)*
- [ ] `entries patch --multiplier 0.5` then `--multiplier 0.75` yields
      0.75×base effective totals in the home view (idempotent rescale,
      observed end-to-end).
      *(CLI side unit-tested: `effectiveMacro`/`sumEffective` always rescale from
      the base, never compound; full round-trip needs the live server.)*
- [ ] `inventory remark "opened the X"` reports matched/unmatched truthfully.
      *(CLI faithfully renders the resolver's `{matched, item?, event?}`; resolver
      accuracy is a live-server behavior.)*
- [x] `receipts scan` posts a batch from photo files with the meta as a form
      field (wire-shape pinned in tests).
- [x] `check:skills` passes; the skill's generated regions match the CLI.
- [x] Leak-scan: no instance data in CLI defaults, fixtures, skill prose, or
      any git surface.

## Risks / unknowns

- **Command-surface creep** — the CLI must stay a veneer; anything needing new
  semantics goes through a spec/API change first, not CLI-side logic.
- **Skill narrative drift** — the decisive rules live in both the spec and the
  skill prose; the generated regions guard commands, not prose. Keep prose
  pointed at the spec rather than restating detail that can rot.

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
