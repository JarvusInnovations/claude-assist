---
status: done
depends: []
specs: []
issues: []
pr: null
---

# Plan: Make CI's test step actually gate

## Why

The `Run tests` step in `.github/workflows/ci.yml` was:

```yaml
- name: Run tests
  run: bun test
  continue-on-error: true
```

Two independent defects that compounded into "the test step proves nothing":

1. **Wrong invocation.** `bun test` (bare) walks the whole repo in one process from
   the root. `bun run test` is the root script → `bun run --filter '*' test`, which
   runs each package's own test script **with that package as cwd**. Only the second
   form lets a package-level `bunfig.toml` apply, and `packages/kitchen` uses one to
   preload a TZ pin its date/timezone assertions depend on. Under the bare form that
   preload never fires and those assertions fail on every run.

   The bare form is also broader in a way nobody wanted: it discovers compiled
   `dist/**/*.test.js` alongside the sources, so it ran ~91 files against ~25 real
   test files' worth of content — the same tests twice, from two different builds.

2. **`continue-on-error: true`** then swallowed the failures the first defect caused.

Net effect, measured rather than inferred: the most recent run before this change
concluded **`success`** while its log carried **32 `(fail)` lines**. Locally the
same invocation reproduces as **39 fail / 38 errors across 562 tests in 91 files**.

**So the step was decorative — a genuine regression would also have reported green.**
Every "CI passed" on this repo has attested to install, the per-package builds,
`type-check:axi` and `check:skills` (all of which do gate), and to nothing at all
about tests.

## Scope

Two lines: `bun test` → `bun run test`, and drop `continue-on-error`. Both are
needed — fixing only the invocation leaves failures unenforced; dropping only
`continue-on-error` turns a false green into a permanent false red.

A comment above the step records why the invocation is not interchangeable, because
`bun test` reads as the simpler, more obvious form and is the natural thing for a
future editor to "tidy" it back to.

## Validation

Reproduce the old behavior, then prove the new one, **in a way that matches CI's
own sequence** (install → build → test). A fresh worktree has no `node_modules` and
no `dist/` — and packages import each other's built output — so testing before
building yields failures that are an artifact of the checkout rather than the code.
That was hit and corrected while writing this.

- [x] Bare `bun test` at root reproduces the failures (documents the defect)
- [x] `bun install --frozen-lockfile && bun run build && bun run test` → **exit 0**, all 10
      packages `0 fail` (kitchen 463 pass on this base)
- [x] The PR's own CI run is the real proof: with `continue-on-error` gone, a green
      check now means the suite passed. If it goes red, that is the fix working and
      a real failure to chase.

## Notes

This is the highest-leverage change available in the repo right now, and not because
the tests were broken — they pass locally. It is that **every other guarantee here
was unfalsifiable while this step was decorative.** Four PRs were merged in one
session on the strength of "CI green" plus separate local runs; the local runs were
doing all the work and the CI signal was worth nothing.

Related: the TZ preload in `packages/kitchen/bunfig.toml` was introduced to replace
an import-time `process.env.TZ` mutation that leaked across the package's test
files. That fix was verified under `bun run test` only, so it traded a load-order
dependency for a **working-directory** dependency and CI kept exercising the broken
path. Worth remembering as a shape: a fix verified through one entry point can leave
another entry point broken, and CI is an entry point.

## Follow-ups

- Consider whether `dist/**` should be excluded from test discovery outright, so a
  bare `bun test` is merely redundant rather than wrong.
- The kitchen TZ pin is load-bearing and reachable only via a package-level bunfig.
  A more robust home (an explicit setup import, or pinning the zone in the test
  helpers) would survive any invocation.
