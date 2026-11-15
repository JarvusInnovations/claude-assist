---
status: in-progress
depends: [kitchen-axi]
specs:
  - specs/behaviors/axi-cli-arguments-and-export.md
  - specs/modules/kitchen.md
issues: [282, 99]
---

# Plan: strict flags and `--json-out` for sessions-axi and kitchen-axi

## Scope

Bring `sessions-axi` and `kitchen-axi` in line with the three "should fix" items
of #282, which include #99:

1. Every command declares its flags and positionals. Anything else fails with
   exit 2 and the valid flags listed.
2. `--json` on stdout is replaced by `--json-out[=path]`. `--json` becomes a
   hinted flag.
3. A plain TOON column carries its data key.

**Out of scope**: `gmail-axi`, `google-axi` and `pages-axi` (see After this
plan), the "Smaller" items of #282 other than the parts this work touches, and
any API change. The CLIs stay veneers over the same endpoints.

## Implements

- **specs/behaviors/axi-cli-arguments-and-export.md** — all of it, for the two
  CLIs it names as conforming.
- **specs/modules/kitchen.md § Agent tooling** — the output-convention line.

## Approach

- **One shared parser and one shared writer**, in `packages/core/src/axi/`
  (`flags.ts`, `json-out.ts`, `errors.ts`). Both CLIs import them by relative
  path, which esbuild inlines into each bundle. The directory is excluded from
  core's `tsc` build, as each package's own `src/axi/` already is, and added to
  `tsconfig.axi.json`.
- The parser is ported from nexudus-axi `src/flags.ts` (the canonical source in
  `.agents/skills/jarvus-axi/references/canonical-sources.md`), keeping this
  repo's convention of flag names without the leading `--`.
- The writer follows agent-recall-axi `src/commands/json-out.ts` (path checked
  before any read, no symlinks) and gws-axi `src/util/export.ts` (private temp
  directory, exclusive create, `export_error:`).
- **A declaration table per CLI** (`flag-specs.ts`), keyed by the command as
  typed. `parseArgs("<command>", args)` looks its spec up there, so a test can
  walk the table.
- **Capture, then write.** The parser validates the export path. The command
  hands its payload to `captureJson`. A wrapper around every handler writes the
  file after the view is built. A command that accepts the flag and captures
  nothing fails, so the flag can never be silently ignored, and an empty-state
  early return still gets its export.
- Exit codes: `UNKNOWN_FLAG` and `USAGE` exit 2 through a shared `formatError`,
  since the SDK version in use maps only `VALIDATION_ERROR`.
- Repeatable flags (`--component`, `--from`, `--step`, `--source`) are declared
  `multi`, replacing the `collectFlag` re-scan of raw argv.
- Columns: drop the display alias from every plain field. Computed columns and
  flattened references keep their own names. The entry detail view keeps
  `base_*`, for the reason the spec gives.

## Validation

- [ ] Every declared command, run with `--bogus`, exits as `UNKNOWN_FLAG`
      listing its flags, with no request sent (table-driven, both CLIs).
- [ ] `sessions-axi search --querry X` fails and sends no request (#99).
- [ ] `--json` fails with the `--json-out` hint on every command, including as
      the last token.
- [ ] An extra positional fails on every command with a fixed count.
- [ ] Every declared flag appears in its command's `--help`.
- [ ] A bare `--json-out` writes a `0600` file in a `0700` `<tmpdir>/<tool>/`
      under a permissive umask; `=path` writes there; the space form, a missing
      directory, a symlink and a directory are refused before any request.
- [ ] Stdout with `--json-out` is the plain view plus `wrote:`, `columns:` and
      one hint, and the printed `jq` command runs.
- [ ] A write that fails after the work keeps the view, prints
      `export_error:` and exits 1.
- [ ] The real binary exits 2 for `--json` (spawned, temp `HOME`).
- [ ] `bun run type-check:axi`, `bun run check:skills` and `bun run test` pass.

## Risks / unknowns

- **Breaking for callers.** `--json` is gone from both CLIs, `details --raw` and
  `engagement --blocks` now need `--json-out`, repeated value flags and extra
  positionals are errors, and many column names changed. No caller inside this
  repo parsed either CLI's `--json` output; an instance's own prompts or scripts
  might, and will get the hint.
- A value that begins with `--<letter>` after a value flag now reads as a
  missing value. `--flag=<value>` is the way through, and the error says so.

## After this plan

- `gmail-axi` and `google-axi` (`packages/google/src/axi/`): give each a
  `flag-specs.ts`, switch `args.ts` to the shared parser, replace each
  `if (flags.json) return rawJson(…)` with `captureJson(…)`, wrap the handlers
  and pass `formatError` in both `cli.ts` files, drop the column aliases. This
  closes #99.
- `pages-axi` (`packages/pages/src/axi/`): it does its own dispatch without
  `axi-sdk-js`. It needs the move onto the SDK first (#282, "Smaller"), then the
  same steps.
- `toon.ts` and `invocation.ts` are still copied per package (#282, "Smaller").
  `packages/core/src/axi/` is now the place for one copy.
