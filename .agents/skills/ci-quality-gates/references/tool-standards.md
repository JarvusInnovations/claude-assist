# Tool standards: the linters, formatters, and the script contract

What runs inside the gate. These are the Jarvus house choices — one linter and
one formatter per language family, no eslint+prettier+biome+mypy sprawl. Adopt
them so new repos stop re-deciding (the portfolio's real failure mode is repos
that ship *no* linter at all).

## The script contract (TypeScript)

Every TS package exposes the **same four scripts**, so CI is stack-agnostic — it
just calls `bun run <name>`:

```jsonc
{
  "scripts": {
    "lint":         "oxlint <src dirs>",       // e.g. "oxlint src bin test" — scope, don't use "."
    "format":       "oxfmt <src dirs>",        // writes
    "format:check": "oxfmt --check <src dirs>",// CI uses this
    "typecheck":    "tsc --noEmit"             // or "tsc -b" for project-references
  }
}
```

> **Naming note.** The type-check script is **`typecheck`** across the Jarvus
> stack skills and the continuous-gtfs flagship. Some older scaffolds named it
> `check` — if you meet one, rename it to `typecheck` so the contract is uniform
> (the workflow templates here call `bun run typecheck`).

Add the tools as dev deps (don't hand-edit `package.json`):

```bash
bun add -d oxlint oxfmt
```

## TypeScript: oxlint + oxfmt + tsc

- **Scope to your source dirs, not `.`.** Pass the actual TypeScript directories
  (`oxlint src bin test`), not a bare `.`. Two traps a bare `.` walks into: it
  lints **vendored content you don't own** — committed skill bundles under
  `.agents/`/`.claude/`, generated `dist/` — surfacing errors from other people's
  code; and **oxfmt formats Markdown by default**, so `oxfmt .` will reformat your
  `specs/**` and `*.md` docs. A bare `.` is only safe in a clean, isolated package
  whose root holds nothing but its own source (e.g. a `ui/` subpackage). When in
  doubt, list the dirs.
- **oxlint** — fast Rust linter. Config is `.oxlintrc.json`.
  - **Single-package repo:** use `templates/oxlintrc.base.json` directly as the
    package's `.oxlintrc.json`.
  - **Monorepo:** put `templates/oxlintrc.base.json` at the repo root as
    `.oxlintrc.base.json`, and give each package a tiny `.oxlintrc.json` that
    extends it:

    ```json
    {
      "$schema": "../../node_modules/oxlint/configuration_schema.json",
      "extends": ["../../.oxlintrc.base.json"]
    }
    ```

    **Mind the `$schema` path in a monorepo.** It's relative to the *package*, so
    it points up to where oxlint is hoisted at the workspace root
    (`../../node_modules/...` for a `apps/web`-depth package), **not** the bare
    `./node_modules/...` that the single-package templates ship with. The same
    adjustment applies to the React config below when it lives in a subpackage —
    fix its `$schema` to match the package's depth.

    **Third layout: multi-package repo *without* a workspace root.** Not every
    multi-package repo is a bun workspace — the continuous-gtfs flagship has no
    root `package.json` at all; each `services/*` package runs its own
    `bun install` and carries its own lockfile. There oxlint is installed *per
    package*, so each `.oxlintrc.json` keeps the single-package
    `"$schema": "./node_modules/oxlint/configuration_schema.json"` (nothing is
    hoisted to point up at), while `extends` still climbs to the shared root
    config: `"extends": ["../../.oxlintrc.base.json"]`. Pick the `$schema` path
    by **where oxlint's `node_modules` actually is**, not by whether the repo
    "looks like" a monorepo.

    A server package that contains a UI subfolder ignores it so the UI is linted
    by its own stricter config: add `"ignorePatterns": ["ui"]`.
- **React/UI packages** get a stricter config — `templates/oxlintrc.react.json`
  (adds the `suspicious` + `perf` categories, react-hooks, react-compiler, and
  import-ordering rules). It's standalone (doesn't extend the base) because it
  needs the `react` plugin and a different category set.
- **oxfmt** — the formatter. CI runs `format:check`; developers run `format`.
- **tsc** — type-check only, `--noEmit` (Bun runs the source; tsc never builds).
  `strict: true` belongs in `tsconfig.json` — type-check *is* a gate, it catches
  a whole class of bugs no linter does.
  - **Project-references monorepo:** if the root `tsconfig.json` has a
    `references` array (packages depending on packages), type-check at the **root
    with `tsc -b`** (build mode), as one job — `tsc -b` builds referenced projects
    in dependency order. A per-package `tsc --noEmit` does *not* build its deps, so
    it fails in a clean CI checkout when a referenced package's declarations don't
    exist yet (it passes locally only because a prior build left them around). So
    the root `typecheck` script is `tsc -b`, and the lint matrix runs per-package
    **lint + format only** (neither needs type info). See the root `typecheck` job
    in `templates/github-actions/lint.yml`.

**Philosophy: correctness-as-error, style-as-warn.** The base config sets the
`correctness` category to `error` and little else — no opinionated style churn on
the backend. The React config tightens to `error` for correctness/suspicious/perf
and uses `warn` for stylistic/import-ordering rules. Formatting is oxfmt's job,
not the linter's.

## Python: ruff (+ uv)

- **ruff** does both lint (`ruff check`) and format (`ruff format`) — it replaces
  black + flake8 + isort + pyupgrade. No black.
- Config block: `templates/ruff.pyproject.toml` → append to `pyproject.toml`.
  Standard rule set `["E", "F", "I", "B", "UP"]`, line length 88. Exempt
  generated files (protobuf, etc.) via `per-file-ignores`.
- Add it with `uv add --dev ruff`. CI runs `uv run --frozen ruff check` and
  `uv run --frozen ruff format --check`.
- **If `pyproject.toml` carries a private git dependency**, don't let lint sync
  it: `uv run --frozen` installs the whole project env, which pulls the private
  dep and forces a token into a gate that never imports the code. Run ruff
  lean instead — `uv run --frozen --only-group dev
  ruff check .` (and the `format --check` twin) — so lint stays credential-free
  and fork-safe. Full rationale in `provisioning.md` ("Credential-free by
  design").
- **mypy is optional.** Data/infra repos that want strict typing add
  `uv add --dev mypy` and a `uv run mypy src/` step with `strict = true`. The
  flagship pipeline skips it; reach for it when the type surface is worth it.

## IaC: OpenTofu

`tofu fmt -check -recursive` + `tofu init -backend=false && tofu validate` per
root module. Format + config-validity only — never `tofu plan` in this gate
(needs state/credentials). See `templates/github-actions/tf-validate.yml`.

## Docs (optional)

A docs site (mkdocs) gets a build gate: `mkdocs build --strict` so a broken link
or missing nav entry fails the PR. Trigger on `docs/**` + `mkdocs.yml` + the
workflow file itself.

**The build gates PRs; the deploy stays push-only.** Docs repos usually already
have a push-to-develop Pages deploy — and it's tempting to leave it at that, but
then a broken link merges green and only fails *after* it's on develop, inside
the deploy run. Split the two in **one workflow with a shared build job**: the
strict build runs on both `pull_request` and `push`, while the Pages
upload/deploy jobs carry `if: github.event_name == 'push'` so PRs get the gate
without the deploy (and without needing the `pages`/`id-token` permissions on
fork PRs). `templates/github-actions/docs.yml` is that shape.

Invoke mkdocs through `uvx` so the theme/plugins ride along without a
project-level dependency:
`uvx --with mkdocs-material mkdocs build --strict` (add a `--with` per plugin
the site uses). No lockfile governs `uvx` here — the docs toolchain floats,
which is acceptable for a docs gate; pin `--with 'mkdocs-material==X.Y'` if a
theme release ever breaks the build.

## Local feedback: the editor, never a git hook

Local fast feedback comes from the editor, not git hooks. Commit
`templates/vscode-extensions.json` as `.vscode/extensions.json` to recommend the
**oxc.oxc-vscode** extension (lint + format-on-save matching CI). Ruff's editor
integration and a sqlfluff LSP play the same role for Python and SQL.

**No pre-commit framework — including on multi-linter repos.** CI is the only gate
(see the enforcement philosophy in `SKILL.md`). Even a repo that lints SQL + Python +
markdown + notebooks runs each tool **directly** in CI (or in its domain workflow),
not behind `pre-commit/action`: `sqlfluff lint --format github-annotation-native`,
`ruff check`, and `oxlint` all emit PR annotations on their own. The framework only
adds per-developer install friction and a `--no-verify` bypass without buying
anything CI doesn't already enforce. (This is a deliberate move *away* from the
pre-commit-driven CI some older repos use, e.g. wmata's `pre_commit.yaml` — new and
migrated repos run the tools directly.)

## Adopting on an existing repo: the one-time migration

Turning a gate on for the first time surfaces a lot of churn. Land it *before*
the workflow commit so the gate is green on its first run — and **keep the
formatting churn in its own commit so the logic delta stays reviewable.** The
single most common mistake is letting whole-file reformatting bleed into the fix
commit, turning a 30-line logic change into a 2,000-line diff nobody can review.
**Format first** so the fix commit lands on an already-formatted tree:

1. **`bun run format` the whole (scoped) tree first** (or `ruff format`) — commit
   as `style:`. Pure mechanical churn: big, but trivial to review because it's
   *only* formatting.
2. **`bun run lint --fix` + hand-fix** the rest — commit as `fix:` / `refactor:`.
   Because the tree is already formatted, this commit is *only* the logic delta —
   small and reviewable. Some autofixes aren't cosmetic (`[...a].sort()` →
   `.toSorted()`, `.includes()` → `Set.has()`, spread-clone → `structuredClone()`):
   review them, but they belong here, **never** in `style:`.
3. **`bun run format` once more** — `lint --fix` can reintroduce formatting, and
   oxfmt isn't always idempotent right after it; re-run until `format:check` is
   clean, folding any churn into the `style:` commit (or a tiny `style:` follow-up).
4. **Add the config files + scripts + workflow** — commit as `ci:`.

Don't batch any of this with feature work. And the smell test: **if a `fix:`
commit's diff is mostly formatting, you sequenced it wrong** — reformat first,
then redo the fix on top so the logic stands alone.

### Repos with a committed generated artifact (drift gates)

Some repos commit a build output guarded by a drift gate — an `axi-skills` CLI
bundle (`scripts/*.mjs` + a generated `SKILL.md`) checked by a `check:*` script,
or similar codegen. Reformatting or lint-fixing the *source* of that artifact
staled the committed copy, so its drift gate goes **red in CI even though
lint/format/typecheck pass** (the bundle no longer matches the reformatted
source). When adopting a gate on such a repo, **rebuild and commit the artifact**
after the format/fix commits (e.g. `bun run build:<tool>`) — or scope
oxlint/oxfmt to exclude the generated source so the bundle never moves. The
committed `.mjs` is `linguist-generated`, so the rebuild collapses in review.

**Beyond adoption: make drift a standing CI gate.** If the repo doesn't already
have a drift check, add one — a job (in the workflow owning that toolchain) that
regenerates the committed artifact with the **pinned** toolchain and fails on
any diff. The flagship's shape, for committed protobuf/gRPC bindings:

```yaml
- name: Regenerate bindings
  run: >
    uv run --frozen python -m grpc_tools.protoc
    --proto_path=../proto --python_out=src --grpc_python_out=src
    ../proto/<pkg>/<service>.proto
- name: Re-apply formatter          # only if the committed files are formatted post-generation
  run: uv run --frozen ruff format src/<pkg>/<service>_pb2.py src/<pkg>/<service>_pb2_grpc.py
- name: Fail on drift
  run: git diff --exit-code -- src/<pkg>/<service>_pb2.py src/<pkg>/<service>_pb2_grpc.py
```

Without this, a `.proto` edit that skips the regen ships a stale client
silently — every other gate stays green. Trigger the workflow on the source
paths (`proto/**`) as well as the artifact's package. Two prerequisites:

- **The generator's version must be lockfile-pinned** (`grpcio-tools` in
  `uv.lock`, invoked via `uv run --frozen`). A floating generator makes the
  gate flap on toolchain drift — red on someone else's upgrade, not on a real
  stale artifact.
- **Regenerate exactly like a developer would** — including any post-generation
  formatting pass — or the diff never comes back clean.
