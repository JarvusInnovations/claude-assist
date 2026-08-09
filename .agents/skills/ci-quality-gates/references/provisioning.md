# Provisioning, caching, and the CI harness

The part of the gate that's identical across every Jarvus repo regardless of
language. Get this right once and lint/test/type-check all ride on it.

## asdf is the single source of tool versions

Every repo already pins its toolchain in `.tool-versions` for local dev (Bun,
uv, Python, OpenTofu, …). CI reads the **same file** — there is no second place
where versions live, so local and CI can't drift.

```
# .tool-versions  (example)
bun 1.3.11
uv 0.10.12
python 3.12.13
opentofu 1.11.5
```

## First: does the asdf composite even fit this repo?

The composite below installs **every** tool in `.tool-versions` via
`asdf-vm/actions/install`, which runs `asdf plugin add <tool>` for each. That only
works if **every pinned tool has a plugin in the asdf registry.** Repos often pin
tools that don't — `duckdb`, say, has no registry plugin, so `asdf plugin add
duckdb` fails and takes down *every job that uses the composite* (a real failure
seen adopting this on a DuckDB monorepo: lint + tf all red, only the non-asdf
Docker job survived). It works locally only because the dev already has the tool.

So choose provisioning by what the repo pins:

- **All pinned tools have asdf plugins** → use the composite (next section). One
  provisioning path, fully cached.
- **`.tool-versions` includes a tool with no asdf plugin** (duckdb, niche tools),
  **or** a job only needs one tool → **skip the composite and provision just what
  each gate needs** with targeted setup actions. This is also faster (no installing
  python/uv/duckdb for a lint job):
  - TS lint/test → `oven-sh/setup-bun@v2` with `bun-version-file: .tool-versions`
  - IaC → `opentofu/setup-opentofu@v1` with `tofu_version` (+ `tofu_wrapper: false`)
  - Python → `astral-sh/setup-uv@v7` (or asdf if uv+python both have plugins)

  Targeted actions still read versions from `.tool-versions` where they can, so
  it stays the single source of truth.

- **A subdirectory pins its own tool** — a repo can deliberately keep a tool
  *out* of the root `.tool-versions` and pin it in a subdir's own
  `.tool-versions` instead (asdf resolves the nearest file walking up). Seen in
  a client deployment repo: the root file pins uv/python/opentofu for the
  pipeline + IaC gates, while a self-contained UI package pins its own bun in
  `<pkg>/.tool-versions`. The composite won't install that tool (it only reads
  the root file), so the package's gate provisions it with a targeted action
  pointed at the nested file:

  ```yaml
  - uses: oven-sh/setup-bun@v2
    with:
      bun-version-file: <pkg>/.tool-versions
  ```

  The nested file is still the single source of truth for that package — local
  asdf and CI read the same file, just a different one than the root.

## The composite action (when every pinned tool has a plugin)

The provisioning steps repeat in every job. Consolidate them into one local
composite action and call it — this is the proven state, not an aspiration:
the continuous-gtfs flagship calls `./.github/actions/setup-asdf` from every
job across `lint.yml` / `test.yml` / `ui-checks.yml` / `docs.yml` (zero
inlined copies), and its composite is byte-identical to the template here.
Don't regress to inlining the block per job — that's how the copies rot apart.

```yaml
steps:
  - uses: actions/checkout@v6
  - uses: ./.github/actions/setup-asdf   # the whole provisioning block
```

Drop `templates/github-actions/setup-asdf/action.yml` at
`.github/actions/setup-asdf/action.yml`. It does four things:

1. **`asdf-vm/actions/setup@v4`** — installs asdf itself.
2. **`actions/cache@v5`** keyed on `hashFiles('.tool-versions')` — restores the
   installed tools. The `restore-keys: asdf-tools-` prefix lets a changed
   `.tool-versions` warm-start from the previous cache instead of a cold install.
3. **`asdf-vm/actions/install@v4`** *only on cache miss* — the slow path,
   skipped on the ~1-minute-saving cache hit.
4. **`asdf reshim`** — regenerates shims so the cached tools are resolvable in
   later steps. Skipping this is the classic "command not found" after a cache
   hit.

`checkout` must come first so the local `./.github/actions/setup-asdf` path
exists before it's referenced.

**Cache-key caveat for nested `.tool-versions`:** the composite's cache key is
`hashFiles('.tool-versions')` — the **root** file only. If the repo also has
per-package `.tool-versions` files (previous section) *and* the composite is
what provisions those jobs, a bump to a nested file won't change the key, so
CI restores a stale toolchain. Either provision those packages with targeted
setup actions (the usual answer — then the composite key correctly covers only
what the composite installs), or widen the key to include them:
`hashFiles('.tool-versions', '**/.tool-versions')`.

## Reproducibility: lockfiles + frozen installs

Commit `bun.lock` and `uv.lock`. CI installs from the lockfile and **fails if it
would change**, so a PR can never pass against dependency versions that aren't
recorded:

- TS: `bun install --frozen-lockfile`
- Python: `uv run --frozen <cmd>` (e.g. `uv run --frozen ruff check`)

## Path-filtered triggers

Each workflow fires only when its domain changes — and always includes its own
file so edits to the workflow re-run it:

```yaml
on:
  pull_request:
    paths: ['pkg/**', '.github/workflows/lint.yml']
  push:
    branches: [develop]
    paths: ['pkg/**', '.github/workflows/lint.yml']
```

In a monorepo, give each package its own paths (or a per-package matrix) so a
front-end change doesn't run the Python gate and vice-versa.

## Credential-free by design

Lint, format-check, type-check, `tofu fmt`/`validate -backend=false`, and
hermetic unit tests need **no secrets**. Keep them that way: they then run on
fork PRs, start instantly (no WIF/cloud auth), and can't leak. Anything needing
credentials (`tofu plan`, integration tests against real services, deploys) is a
*different*, later gate — out of scope here (see SKILL.md boundary).

The one exception: pulling a **private git dependency/module**. That needs a
repo-scoped token, not cloud credentials — a `git config --global url.…insteadOf`
rewrite (commented in `test.yml` / `tf-validate.yml`). It stays cheap and
fork-safe-ish; just be aware forks won't have the secret.

**Keep that exception out of the lint gate.** On a Python repo whose
`pyproject.toml` carries a private git dependency, a plain
`uv run --frozen ruff check` syncs the *whole* environment first — dragging the
private dep (and therefore the token) into a job that never imports the
project. ruff doesn't need the project installed at all, so run it lean:

```bash
uv run --frozen --only-group dev ruff check .
uv run --frozen --only-group dev ruff format --check .
```

That installs only the `dev` dependency group (where ruff lives), so lint stays
credential-free and fork-safe. The token rewrite is scoped to `test.yml` /
`tf-validate.yml` — the gates that genuinely need the dependency resolved.

## What this deliberately is NOT

- **No pre-commit framework — at all.** CI is the gate; the editor is the fast
  local feedback loop (see `tool-standards.md`). Linters run **directly** in CI and
  emit their own PR annotations; we don't wrap them in `pre-commit/action`, even on
  multi-linter (SQL/Python/markdown) repos.
- **No build/publish/deploy here.** Those belong to per-stack build docs and the
  deploy/sysadmin skills. Release PR automation belongs to `release-flow`.
