# ci-quality-gates

Stands up the **pre-merge CI quality gates** a repo runs before code lands on `develop`:
the toolchain provisioning, then **lint + format-check + type-check + test**, using Jarvus's
standard linters — **oxlint + oxfmt** for TypeScript, **ruff** for Python, **tofu fmt/validate**
for infrastructure.

The reusable core is the *gate harness* — asdf provisioning + caching, the `lint` /
`format:check` / `typecheck` script contract, path-filtered workflows, lockfile-frozen installs.
Linting is one tier that rides on it, next to type-check and test.

## When you'd want it

Reach for it whenever a repo needs its checks set up or tightened:

- **standing up CI on a new repo** — get the whole gate by default instead of re-deciding,
- **a repo runs tests but no linter** (the portfolio's most common gap), or ships a Vite-default
  eslint you want to swap for the house oxc setup,
- **choosing/standardizing linters** so every repo uses the same tools and script names,
- **CI that re-installs tools slowly** — the cached asdf composite fixes that.

It deliberately **stops at the merge line**. Release-PR automation is `release-flow`; container
build/publish and deploy belong to per-stack build docs and the `sysadmin`/deploy skills;
credentialed checks (`tofu plan`, integration tests) are a separate later gate.

## What it gives the agent

- a one-place **provisioning composite action** (asdf + cache + reshim) to call from every job,
- copy-ready **GitHub Actions** templates (`lint`, `test`, `ui-checks`, `tf-validate`, `docs`),
- the **oxlint/oxfmt** configs (base + stricter React) and the **ruff** rule block,
- the **TS script contract** and the one-time **adoption migration** recipe so an existing repo
  goes green on the gate's first run.

## Install

**Recommended scope: global.** You reach for this to *bootstrap* a repo's CI — often before it
has any skills wired up — so it's most useful installed once for all your projects.

```bash
npx skills add --global JarvusInnovations/agent-skills --skill ci-quality-gates
```

Then ask your agent to set up the quality gates. See `SKILL.md` for the build order and
`references/` for the provisioning and tool-standards deep dives.
