---
status: done
depends: [assist-pages-skill]
specs:
  - specs/modules/pages.md
issues: []
---

# Plan: `pages-axi publish-worksheet` — reach the worksheet half of the publish API

## Scope

`POST /api/pages` accepts **either** authored `html` **or** a `worksheet`
definition. The CLI only ever exposed the first, so the worksheet pattern — the
module's own answer to hand-rolled collection pages — has been reachable only by
hand-assembling JSON and curling it. Every caller has done exactly that.

- Add `publish-worksheet <definition.json> --slug <slug> [--title] [--digest-optin]`.
- Read the definition from a file (or `-` for stdin), post it, print the stable URL
  plus whether the page was created or revised.
- Surface `WorksheetValidationError` messages verbatim rather than a bare `400`, so a
  malformed definition is self-correcting.

**Explicitly out of scope — and this is a contract, not an omission**: any flag that
names a domain disposition (`--cook eaten|packed` and anything like it). `cook_mode`
travels as opaque data inside the definition. See § Approach.

## Implements

- **specs/modules/pages.md § Agent tooling** — the `publish-worksheet` command.
- **specs/modules/pages.md § The CLI carries no domain vocabulary** — the boundary this
  plan must not cross.

## Approach

The command is thin: read JSON, post, report. The design content is the boundary.

**The module layer already refuses this coupling deliberately** — `cook_mode`'s
consumer is injected as `worksheetCookSink`, composed by the server, and this package
imports nothing from any domain module. A convenience flag like `--cook eaten` would
reintroduce at the CLI layer precisely the dependency the module layer was built to
avoid, and would force a change here for every future domain sink.

So the definition passes through untouched. Domain modules that want ergonomic
authoring wrap this CLI from above — which is strictly better anyway, since only the
domain knows its own reference values and identifiers.

## Validation

- [x] A worksheet definition file publishes and returns a stable URL; the rendered
      page collects quantities and computes totals server-side.
- [x] Republishing the same slug adds a version and retains the prior definition
      (definitions hang off the version, per § Data model).
- [x] A definition with an invalid field key / unknown key / out-of-bounds quantity
      fails with the module's own validation message, not a generic HTTP error.
- [x] A definition carrying `cook_mode` publishes and functions **without the CLI
      containing any domain-specific token** — verifiable by grep over the CLI source
      for disposition names.
- [x] `--help` documents the command; the generated SKILL.md reference includes it.

## Risks / unknowns

- **Definitions are verbose enough that hand-authoring stays unpleasant** even with
  this command. That is expected and correct — the ergonomic path is a domain wrapper
  (see `kitchen-prep-sheets`), and this command is the generic floor beneath it, not
  the intended everyday interface.

## Notes

Landed with `assist-pages-skill` in one commit (see that plan's Notes for why).

**Verified against a live server across all four paths**, not just the happy one:

| case | result |
| --- | --- |
| valid definition | published, `worksheet: true`, version 119 |
| republish same slug | version 120, `created: false` — same URL |
| malformed JSON | CLI-side failure quoting the expected shape |
| invalid definition | `worksheet.fields[0].key must match ^[a-z][a-z0-9_]*$` — **the module's own message**, verbatim |

That last row is the one worth keeping: a bare `400` would have sent the author to the
spec, and the whole reason hand-assembly was painful is that nothing told you what was
wrong with what you wrote.

**The boundary held.** The CLI contains no disposition token — `cook_mode` is parsed
only as part of the surrounding JSON and forwarded untouched. Grep the source for
`eaten`/`packed` and there are no hits.

`-` reads the definition from stdin, which makes a domain wrapper able to pipe rather
than write a temp file.

## Follow-ups

- **Tracked as** `kitchen-prep-sheets` — the ergonomic authoring path. This command is
  deliberately the generic floor, not the everyday interface; hand-authoring a
  definition remains verbose by design.
