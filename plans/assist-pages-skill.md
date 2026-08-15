---
status: done
depends: []
specs:
  - specs/modules/pages.md
issues: []
---

# Plan: bundle `pages-axi` as the `assist-pages` skill

## Scope

Bring the pages module to the tooling parity every sibling module already has: a
built CLI bundle plus a hand-authored skill, registered with the repo's
`build:skills` / `check:skills` machinery.

Today `pages-axi` exists only as unbundled TypeScript at
`packages/pages/bin/pages-axi.ts`. It is absent from `TARGETS` in both
`scripts/build-cli.ts` and `scripts/build-skill.ts`, ships in no skill, and is
therefore undiscoverable to any session that did not already know the file path.

- Move the entry point to `packages/pages/src/axi/` to match the sibling layout
  (`sessions`, `google`, `kitchen`), keeping the existing command implementations.
- Register the build target → `skills/assist-pages/scripts/pages-axi.mjs`, plus the
  `pages-axi` shim.
- Author `skills/assist-pages/SKILL.md` with a generated command-reference block and
  the splice function registered in `build-skill.ts`.

**Out of scope**: the `publish-worksheet` command (its own plan), any change to the
module's API surface, and instance installation.

## Implements

- **specs/modules/pages.md § Agent tooling** — the CLI/skill pair, the home view, and
  the packaging rule ("a CLI other sessions are expected to invoke is not shipped
  until it is bundled as a skill").

## Approach

Follow `assist-kitchen` exactly — it is the most recent instance of this pattern and
already solved the shim, the `.mjs` bundle, the drift gate, and the SKILL.md
generation. This plan is deliberately mechanical; the judgment was spent on the spec.

The **home view** is the one piece of new design: invoked bare, print active pages
newest-first with `unprocessed_count`, because § Principles already establishes that a
page's real status is its response backlog.

## Validation

- [x] `bun run build:skills` produces `skills/assist-pages/scripts/pages-axi.mjs`
      and the shim; `bun run check:skills` passes clean on a fresh checkout.
- [x] `pages-axi` invoked bare prints the home view (active pages +
      unprocessed counts), not a usage dump.
- [x] `pages-axi --help` lists every command; each subcommand's `--help` documents
      its own flags.
- [x] The skill is installable via the repo's normal skill-install path and resolves
      without `bun`, a checkout of this repo, or a specific working directory.
- [x] No behavior change to any endpoint — the CLI remains a veneer.

## Risks / unknowns

- **The move from `bin/` to `src/axi/` touches import paths** in whatever currently
  references the entry point; a stale reference would surface only at build time.
- **The skill name is a public identifier** — renaming later is a breaking change for
  anyone who installed it, so `assist-pages` should be confirmed before first publish.

## Notes

Landed together with `pages-axi-worksheet` in one commit — executed sequentially in a
single pass rather than as parallel worktree waves, so splitting the diff would have
been artificial. Both plans' validation was exercised against a live server.

**Two defects the move surfaced, neither anticipated:**

1. **The CLI could never have run under `node`.** It used `Bun.file` for reads while
   the bundle is invoked through a `node` shim — so the moment it was packaged it
   would have failed on `publish`. Unbundled source hid a bug that packaging exposed
   immediately, which is its own argument for the rule this plan implements.
2. **Double shebang.** The source carried `#!/usr/bin/env node` and esbuild prepends
   its own banner, producing a syntax error on line 2 of the bundle. The sibling bins
   carry no shebang; this one now matches.

**The home view justified itself on first run**: 57 active pages and **17 unprocessed
responses** across 12 pages. That backlog was invisible precisely because nothing
summarized it — the signal § Principles calls a page's real status had no surface.
The per-page nudges are capped at 3 for the same reason.

## Follow-ups

- **Issue** — page titles are stored with HTML entities (`&amp;` renders literally in
  the index and CLI output). Pre-existing data + encoding defect, unrelated to this
  plan; needs a decision on encode-at-write vs decode-at-read before touching rows.
- **None** otherwise — `publish-worksheet`, the obvious follow-up, has its own plan and
  landed alongside this one.
