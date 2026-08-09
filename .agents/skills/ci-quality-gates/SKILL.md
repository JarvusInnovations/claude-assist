---
name: ci-quality-gates
description: >-
  Stand up the pre-merge CI quality gates a repo runs before code lands on develop — tool provisioning (asdf + .tool-versions + cache), lockfile-frozen installs, path-filtered GitHub Actions, and the lint / format:check / typecheck / test gate set with Jarvus's standard linters (oxlint + oxfmt for TypeScript, ruff for Python, tofu fmt/validate for IaC). Use when setting up CI for a new repo, adding a lint/format/type-check/test gate to an existing one, wiring GitHub Actions for code quality, choosing or standardizing linters/formatters, fixing CI that re-installs tools slowly, or noticing a repo runs tests but no linter. Scope stops at merge — Release-PR automation belongs to release-flow; build/publish/deploy to per-stack build + deploy skills. Triggers: "set up CI", "add linting/CI", "GitHub Actions checks", "oxlint", "oxfmt", "ruff", "format check", "type-check in CI", "quality gate", "lint isn't running in CI", "asdf in CI".
---

# CI quality gates (pre-merge checks)

Sets up the checks that gate a pull request **before it merges to `develop`**:
the toolchain provisioning, then lint + format-check + type-check + test, with
Jarvus's standard linters. The reusable core is *the gate harness* — provisioning,
the script contract, path filters, lockfile-frozen installs — and linting is one
tier that rides on it next to type-check and test.

The portfolio's actual failure mode isn't picking the wrong linter; it's repos
that ship **no linter at all** (tests + type-check only, or build + test only).
This skill exists so a new repo gets the whole gate by default instead of
re-deciding — or skipping it.

## Scope: what's in, what's out

| In scope (gates a PR before merge) | Out of scope (hand off) |
| --- | --- |
| asdf provisioning + tool caching | Release-PR automation → **`release-flow`** |
| lint, format-check, type-check, test | Container build / image publish → per-stack build docs |
| IaC `fmt` + `validate` (credential-free) | Deploy / `tofu apply` → **`sysadmin`** / deploy skill |
| docs `build --strict` (optional) | `tofu plan` & integration tests needing secrets (later gate) |

One-sentence charter: **how a repo gates a PR before it merges.** If credentials
or a release tag are involved, it's a different skill.

**Know the hole this scope leaves: Dockerfiles.** Image builds being
out-of-scope means a Dockerfile break passes every PR gate and first fails
*after* merge, on the push-triggered build workflow. Adopters should accept
that consciously — the fix, when it has bitten, is a docker-build smoke job in
the PR gate set (build, don't push; still credential-free), not moving
publish/deploy here. Where image builds *are* gated is the per-stack build
docs and deploy skills. (Frontend `vite build` is different — that one is
in-scope and cheap; see `ui-checks.yml`.)

## Enforcement philosophy

Three decisions shape how everything below is wired:

**1. CI is the only gate — no pre-commit.** The gate lives in CI and nowhere else.
Pre-commit hooks are per-developer (must be installed, drift between machines, and
are one `--no-verify` from being skipped), add commit-time friction, and only ever
*duplicate* what CI already enforces authoritatively. So **don't ship a
`.pre-commit-config.yaml`.** Run each linter **directly** in CI — `oxlint`,
`oxfmt --check`, `ruff check`, `sqlfluff lint --format github-annotation-native` —
which keeps inline PR annotations without the framework. Local fast feedback comes
from the **editor** (oxc-vscode, ruff, a sqlfluff LSP) and from running the same
`bun run <gate>` / tool commands by hand — never a git hook.

**2. Organize workflows by gate; co-locate by toolchain.** The default lanes are
`lint` and `test`, each a workflow whose jobs fan out per package/language. But when
a domain brings a **distinct toolchain**, give it its **own workflow whose jobs are
named by gate** instead of forcing that toolchain into the generic lint/test
workflows. Terraform (`tf-validate.yml`: `fmt` + `validate`) is the first instance;
**dbt** is the second — its `sqlfluff` linter compiles models *through dbt*, so it
needs the same `uv` + `dbt deps` + profile setup as `dbt parse`/unit-tests.
Co-locating those in one `dbt.yml` (jobs `lint` / `parse` / `unit-test`) stands the
toolchain up once and keeps the gate semantics legible; splitting them across
`lint.yml` and `test.yml` would provision dbt twice. **Rule of thumb: one workflow
per toolchain, jobs named by gate.** Fold into the shared `lint.yml`/`test.yml` only
when a check rides the *same* toolchain those already set up.

**3. Stack skills own their tools; this skill owns the harness.** Each
`jarvus-{tech}` stack skill defines its tech's linter/formatter/test choices,
configs, and `package.json`/script contract, and carries a short "CI & Code Quality"
section pointing here. This skill owns provisioning, the gate taxonomy, the
path-filter / lockfile-frozen / credential-free rules, and the workflow templates. A
stack skill that introduces a distinct toolchain ships its **domain workflow** (its
lane of this contract) — e.g. **`jarvus-dbt`** ships `dbt.yml`. A new stack plugs
into these rules rather than reinventing CI.

## The two reference deep-dives

| File | Read when |
| --- | --- |
| [provisioning.md](references/provisioning.md) | the CI harness — asdf + cache composite, lockfile-frozen installs, path filters, credential-free principle, private-dep git rewrite |
| [tool-standards.md](references/tool-standards.md) | the linters/formatters — the TS script contract, oxc + ruff configs, the `typecheck` naming convention, the editor-feedback loop (no pre-commit), the one-time adoption migration |

## The gate set

| Gate | TypeScript | Python | IaC |
| --- | --- | --- | --- |
| Lint | `oxlint` | `ruff check` | — |
| Format | `oxfmt --check` | `ruff format --check` | `tofu fmt -check` |
| Types | `tsc --noEmit` | `mypy` (optional) | `tofu validate -backend=false` |
| Test | `bun test` | `pytest` | — |

All four TS gates are invoked through a fixed **script contract** —
`lint` / `format` / `format:check` / `typecheck` — so the workflow is identical
across packages and only calls `bun run <name>`. Details + the naming caveat in
[tool-standards.md](references/tool-standards.md).

**DB-backed tests stay in this gate — they just need a database.** A `bun test` /
`pytest` suite that hits Postgres is still fork-safe (no secrets), so it belongs
here: give CI an **ephemeral service-container Postgres** and an explicit
`DATABASE_URL`. Locally, that same `test` script gets an isolated DB from
**`agent-dev-workflow`**'s `bin/test` + test preload, whose `??=` defers to CI's
`DATABASE_URL`. (Integration tests that need *secrets* are the separate later gate
in the scope table above.)

## The universal harness (don't reinvent it)

Every job, every language, shares the same provisioning. Consolidate it into one
local composite action and call it after checkout:

```yaml
steps:
  - uses: actions/checkout@v6
  - uses: ./.github/actions/setup-asdf   # asdf + cache + reshim, one place
```

Plus three rules that make CI reproducible and cheap (full rationale in
[provisioning.md](references/provisioning.md)):

- **`.tool-versions` is the only place tool versions live** — local dev and CI
  read the same file, so they can't drift.
- **Lockfiles committed; CI installs frozen** — `bun install --frozen-lockfile`,
  `uv run --frozen …`. A PR can't pass against unrecorded dependency versions.
- **Path-filtered triggers** — each workflow fires only on its domain (and on
  edits to itself).
- **Leave `pull_request.branches` unrestricted** — filter PR triggers by
  `paths`, never by base branch. In the develop→main Release-PR flow, the
  release PR targets `main`; an unrestricted `pull_request` trigger re-runs the
  full gate set on it alongside release-validate, re-gating exactly what's
  about to ship. Adding `branches: [develop]` to `pull_request` silently
  un-gates release PRs. (The `push` trigger *does* restrict to
  `branches: [develop]` — that one's correct.)
- **Credential-free** — lint/format/type-check/validate/hermetic-tests need no
  secrets, so they run on fork PRs and start instantly.

## Templates

`references/templates/` — copy and adapt (each carries `# ADAPT:` markers):

| Template | Drop at | Purpose |
| --- | --- | --- |
| `github-actions/setup-asdf/action.yml` | `.github/actions/setup-asdf/action.yml` | the shared provisioning composite |
| `github-actions/lint.yml` | `.github/workflows/lint.yml` | ruff + oxc/tsc lint gate (per-package matrix) |
| `github-actions/test.yml` | `.github/workflows/test.yml` | pytest + bun test gate |
| `github-actions/ui-checks.yml` | `.github/workflows/ui-checks.yml` | single-package frontend lint+fmt+types+test+build |
| `github-actions/tf-validate.yml` | `.github/workflows/tf-validate.yml` | OpenTofu fmt + validate |
| `github-actions/docs.yml` | `.github/workflows/docs.yml` | mkdocs strict build gates PRs; Pages deploy on push only |
| `oxlintrc.base.json` | `.oxlintrc.json` (or root `.oxlintrc.base.json` in a monorepo) | TS lint config — correctness=error |
| `oxlintrc.react.json` | `<ui>/.oxlintrc.json` | stricter React/UI lint config |
| `ruff.pyproject.toml` | append to `pyproject.toml` | ruff rule set |
| `vscode-extensions.json` | `.vscode/extensions.json` | recommend oxc-vscode for local feedback |

## Build order

1. **Read [provisioning.md](references/provisioning.md) and
   [tool-standards.md](references/tool-standards.md) first.** They carry the
   rationale and the gotchas (reshim-after-cache, the `typecheck` naming convention).
2. **Confirm `.tool-versions` exists** and pins everything CI needs (bun, uv,
   python, opentofu — whatever applies). If not, set it via `asdf set …` first.
3. **Drop the composite action** at `.github/actions/setup-asdf/action.yml`.
4. **Add per-language config + scripts:** oxc configs + the four `package.json`
   scripts for TS; the ruff block + `uv add --dev ruff` for Python.
5. **Add the workflows you need**, delete the jobs you don't, fix the `paths:`
   and `working-directory:` to the repo's real layout.
6. **For an existing repo, land the one-time format/lint-fix as a separate commit
   *before* the workflow commit** (see the migration section in
   [tool-standards.md](references/tool-standards.md)) so the gate goes green on
   its first run.
7. **Commit `.vscode/extensions.json`** so local editors match CI.
8. **Verify**: open a PR (or push a branch) and confirm each gate runs, is
   green, and a deliberate violation actually fails it. Don't assume — a
   mis-filtered `paths:` silently skips the gate, which reads as "passing".

## Guardrails

- **Don't let the gate need secrets.** The moment a "lint" job wants cloud
  credentials, it's the wrong job — split the credentialed check into its own
  later workflow. Keep this set fork-safe and instant.
- **One linter + one formatter per language.** oxc for TS, ruff for Python. Don't
  add eslint/prettier/biome/black alongside — that's the sprawl this replaces. A
  Vite scaffold ships a default eslint; remove it when adopting oxc.
- **Type-check is a gate, not a nicety.** `tsc --noEmit` / strict mode catches
  bugs no linter does — keep it required.
- **No pre-commit framework.** CI is the only gate; run linters directly in CI (they
  emit PR annotations natively). Local feedback is the editor + running the gate
  commands by hand. Don't add a `.pre-commit-config.yaml` — even on multi-linter
  repos (ruff + sqlfluff + markdown), run each tool directly in CI or in the domain's
  workflow. See the enforcement philosophy above and
  [tool-standards.md](references/tool-standards.md).
- **Stay before the merge line.** Release, build, publish, deploy, and
  credentialed plans belong to other skills. If you're editing
  `release-prepare.yml` or a deploy workflow, you're in the wrong skill.
