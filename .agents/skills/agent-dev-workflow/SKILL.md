---
name: agent-dev-workflow
description: Set up an agent-friendly local dev workflow — a bin/ task-runner (inspired by GitHub's scripts-to-rule-them-all) over a shared Postgres container that gives every git worktree its own isolated database and ports, plus a dedicated test database so tests never clobber dev data. Use this whenever a project needs worktree-isolated local development, when setting up for AI agent orchestrators (Conductor and similar) that spin up a worktree per session and register setup/run/cleanup commands, when multiple copies of a backend must run concurrently on one machine, when replacing a docker-compose-for-local-postgres setup, when deciding whether auxiliary dev services (a validator container, a local OIDC IdP) replicate per worktree or run shared, when merged agent worktrees pile up and need sweeping, or when tests keep wiping local dev/demo data. Triggers on "bin/ scripts", "worktree isolation", "per-worktree database/port", "scripts to rule them all", "agent dev environment", "setup/run/cleanup scripts", "shared auxiliary services", "sweep merged worktrees", or tests clobbering the dev database.
---

# Agent-friendly dev workflow (bin/ + worktree isolation)

This skill scaffolds a `bin/` task-runner that lets **many copies of a project run
concurrently on one machine** — one per git worktree — each with its own database
and port, sharing a single Postgres container. It's the contract AI agent
orchestrators (Conductor and similar) want: register `setup` / `run` / `cleanup`
once and every session gets an isolated environment for free. As a high-value side
effect, tests run against a dedicated database and **can never wipe your dev data**.

It's modeled on GitHub's *scripts-to-rule-them-all*, but uses `bin/` (the name
`script/` never caught on) and adds the worktree-isolation layer.

## When this is the right tool

A project backed by Postgres where you want any of: concurrent worktree dev,
orchestrator setup/run/cleanup hooks, an end to tests clobbering dev data, or a
replacement for a docker-compose-just-for-local-postgres. If there's no database,
most of this doesn't apply. If there's no concurrency need *and* tests already use
a separate DB, the payoff is small.

## The core idea: identity derives from the worktree

One shared Postgres container (started once, reused by name — path-independent, so
it survives worktree deletion). Each context gets a **database** and a **port per
process it runs**, derived from its worktree path:

| Context | Database | Port(s) |
| --- | --- | --- |
| Main checkout | the canonical name (durable dev data) | the default(s) (e.g. 4000) |
| Each agent worktree | `app_<hash-of-path>` (isolated) | next free in each range |
| The test runner | `app_test` (forced) | n/a |

A worktree isn't necessarily one process: a repo may run an HTTP API + a gRPC
service + a Vite frontend per worktree. The pattern generalizes cleanly — the
project's port band claims **one range per process kind**, `_common.sh` grows one
picker per kind, and `bin/setup` emits every derived port **plus the wiring vars
that connect the processes** (e.g. `ORCHESTRATOR_URL`). One note: gRPC ports
aren't curl-checkable — readiness-probe them with a plain TCP check.

Because identity comes from the path, two sessions never collide and re-running
setup is idempotent. Every derived value has an env override (`APP_DATABASE`,
`APP_PG_PORT`, `PORT`, …) for explicit orchestrator control.

## What's invariant vs. project-specific

The whole point of distilling this from several real Postgres-backed projects is to
know which parts you copy verbatim and which you adapt.

**Invariant** (copy from `references/bin/`, just swap the `app`/`APP_` prefix):

- worktree-aware DB naming (`app_db_name`, `app_db_name_for_root`,
  `is_main_worktree`, `app_hash`)
- shared-container management (`ensure_postgres`, `wait_for_postgres`, `app_psql`)
- DB create/recreate helpers; the `setup`/`reset-db`/`db`/`cleanup`/`test` scripts
  (keep these names — e.g. `db`, not `query` — so the muscle memory transfers across repos)
- port picking (`port_in_use`, `find_available_port`, `app_pick_port`) — **including
  the macOS `lsof`/`ss` split; do not "simplify" it away** (see gotchas)
- stdout=env / stderr=status discipline
- the dev-session **state machine** (fullstack variant): the atomic noclobber
  claim of `.dev/state.env` with `PHASE=booting` → `PHASE=running` only after
  ports listen, snapshot-coherent reads, the ownership-checked EXIT/INT/TERM
  trap, per-child process groups via `set -m` (never `kill 0`), and
  `app_dev_stop`
- **pid + start-time identity** (`app_pid_lstart`, `app_pid_is`) consulted
  before every kill and every health verdict (see gotchas — pid recycling)
- the `bin/gc` proof structure: mandatory gates + at least one containment
  proof, the long-lived-branch denylist, the canonical-DB guard, and the fd-3
  record stream (see gotchas — stdin-slurping loops)

**Project-specific** (the knobs you set):

- the prefix, PG user/password/image, container/volume names
- the **base port band** — the default PG port plus one worktree range **per
  process kind** (backend HTTP, gRPC, frontend, …). This is the project's claim on
  the machine: worktree isolation keeps a project's *own* copies apart, but the
  base band is what keeps *different projects* from colliding when several run at
  once. Pick a distinct, uncommon band per repo (see gotchas) and keep PG + every
  process range in one coherent band.
- the Postgres **major** — pin the same one production runs (`references/snapshots.md`)
- `app_server_dir` — repo root (single package) vs a subdir (monorepo)
- `app_migrate` — how migrations run → **`references/migrations-and-seeds.md`**
- single-service `dev` (frontend runs separately) vs fullstack `dev` (an
  attach-aware per-worktree singleton that starts both, supervises both, and
  kills both) → use `references/bin/dev` or `references/bin/dev-fullstack`
- `bin/gc`'s integration branch — `APP_GC_BASE_REF` defaults to `origin/main`;
  set `origin/develop` in repos that integrate on develop
- the **seed posture** — synthetic SQL, snapshot-as-seed, or empty + per-suite
  fixtures (`references/migrations-and-seeds.md`), and whether it has prod snapshots
  at all (`references/snapshots.md`)
- whether the repo has **auxiliary services** and what shared endpoints to seed
  into worktree envs (next section)

## Auxiliary services: shared per machine, never per worktree

What replicates per worktree is **the app + its database — nothing more**.
Auxiliary services (a GTFS validator container, a local OIDC IdP, a fake object
store) run **once per machine** and are shared by every worktree instance; each
worktree's env just points at the shared endpoints. N worktrees hitting one
validator is fine — one container instead of N is the difference between "docker
is fine" and "my laptop is swapping".

This fixes the docker-compose question cleanly:

- **No aux services** (the dev flow is just app + DB) → **no compose at all**.
  `bin/` owns the shared Postgres container directly, as prescribed.
- **Aux services exist** → compose covers **only those**: `docker compose up -d`
  once per machine. The compose file never contains the per-worktree app or
  Postgres — those stay with `bin/`.

Don't expand `bin/` into orchestrating aux containers; hold the boundary instead:
**`bin/` = per-worktree identity** (DB, ports, app processes); **compose =
machine-wide singletons**.

**Env seeding** is the connective tissue: `bin/setup` emits the shared endpoints
alongside the per-worktree values (e.g. `VALIDATOR_URL=http://localhost:9010`,
overridable via env like everything else), so one stdout capture threads into the
run step and every worktree converges on the same shared services.

## Worktree lifecycle: create under `.claude/worktrees/`, sweep with `bin/gc`

Agent worktrees should live under the repo's **`.claude/worktrees/`** directory
(gitignore `**/.claude/worktrees/` so nested checkouts never show as untracked
files). That location is what makes the end of the lifecycle automatic: a
worktree is alive while its PR is in review and becomes garbage the moment it
merges — but merges happen on the reviewer's schedule, with no local session
listening. `bin/gc` closes that gap with a lazy, state-based sweep: it
enumerates linked worktrees under any `*/.claude/worktrees/` path and removes
only the ones it can **prove** merged (ancestry, `git cherry` patch
containment, or a merged PR via `gh` — plus mandatory gates: clean, unlocked,
not the main/current worktree, not a long-lived branch), stopping any recorded
`bin/dev` session and dropping the derived database along the way. Everything
unproven is skipped with a one-line reason; a `--nudge` mode is cheap enough to
run from a SessionStart hook. Worktrees created *outside* `.claude/worktrees/`
escape the sweep entirely — that's the trade you make by putting them
elsewhere.

## Build order

1. **Read the relevant references first** (below) — they encode hard-won bugs.
2. Copy `references/bin/*` into the project's `bin/`, rename the prefix, fill the
   constants in `_common.sh`. **Claim a base port band** well outside 5432 and
   distinct from your other projects (see gotchas — or derive it from a hash of the
   repo name). Pin the **same Postgres major as production** so snapshots restore
   cleanly (`references/snapshots.md`).
3. Set `app_server_dir` and `app_migrate` for this project
   (`references/migrations-and-seeds.md`).
4. Choose the `dev` variant (single-service vs `dev-fullstack`). The fullstack
   variant carries the whole session protocol (singleton claim, attach,
   status/stop/logs, supervision) — copy its mechanics verbatim and adapt only
   the two child-launch blocks. Copy `bin/gc` alongside it and set
   `APP_GC_BASE_REF` if the repo integrates on a branch other than `main`.
5. Wire **test isolation** — the preload that points tests at `app_test`
   (`references/test-isolation.md`). Do this when (or before) the project grows a
   DB-backed test suite: it's the step that stops tests wiping dev data. It's a clean
   add later, but if you know tests are coming, scaffolding `bin/test` + the preload
   up front means the *first* test is born-isolated.
6. `chmod +x bin/*` (not `_common.sh`). If a `docker-compose.yml` exists, evict
   its Postgres (and app) services — delete the file outright if that's all it had;
   keep it only as the once-per-machine aux-services runner (see "Auxiliary
   services" and gotchas). Update `.env.example` + the project's agent docs
   (CLAUDE.md or equivalent) to point at `bin/`.
7. **Verify** end to end (don't assume): `bin/setup` on a clean checkout; the
   sentinel-row test from `test-isolation.md`; `bin/dev` in two *worktrees* lands on
   two different ports; `bin/dev` twice in the *same* worktree → the second
   attaches (exit 0, `KEY=VALUE` block) instead of double-booting; kill one
   child process → the whole stack exits loudly (no half-dead session);
   `bin/gc --dry-run` reports sane verdicts; `bin/cleanup` in a throwaway
   worktree leaves the main DB intact. `bash -n` every script.

## Reference files

| File | Read when |
| --- | --- |
| `references/bin/` | always — the script templates you copy + adapt |
| `references/test-isolation.md` | wiring tests to `app_test` (the preload), **and** authoring suites against it (in-process `inject`, scoped truncate, fixtures) — almost always |
| `references/migrations-and-seeds.md` | setting `app_migrate`; deciding on seeds |
| `references/gotchas.md` | **before writing port logic or picking a PG image** — the silent-failure bugs |
| `references/orchestrator-integration.md` | wiring Conductor/orchestrator setup/run/cleanup; the stdout/stderr contract |
| `references/snapshots.md` | only if the project has a production DB to snapshot (skip for greenfield) |

## Where this meets `ci-quality-gates`

This skill and **`ci-quality-gates`** are complementary and meet at exactly one
seam: the **`test` script**. `ci-quality-gates` owns the script contract
(`lint`/`format`/`format:check`/`typecheck`/`test`) and the CI workflow that runs
`bun run test` against an **ephemeral service-container Postgres** with an explicit
`DATABASE_URL`. This skill owns what that same `test` script connects to **locally**:
`bin/test` + the `bunfig.toml` preload force an isolated `app_test` DB, and the
preload's `??=` is the handshake that lets CI's explicit `DATABASE_URL` win. Adopt
both together for a DB-backed app — the CI skill defines the gate, this skill keeps
it from clobbering dev data. (SquadQuest is the worked example: a `"test": "bun test"`
script, `bin/test`, and a `bunfig.toml` preload that defers via `??=`.)

Some repos deliberately run CI with **no database at all** (live-DB suites
self-skip). That's a legitimate posture too — but the preload must then skip
when Postgres is unreachable instead of failing the run. See
`test-isolation.md` §CI for both postures.

## Guardrails

- Keep the scripts to **database + process lifecycle**. Rich demo/fixture data is
  the app's concern and churns fast — at most a thin idempotent seed hook
  (`migrations-and-seeds.md`). A bloated `bin/` stops being portable.
- These are dev-only. **CI keeps its own explicit `DATABASE_URL`** against an
  ephemeral DB (a GitHub Actions service-container Postgres, owned by
  **`ci-quality-gates`**); the test preload's `??=` defers to it. Verify CI stays
  green; you shouldn't need to touch the CI workflow.
- Don't drop the canonical dev DB casually — `bin/cleanup` guards it behind
  `--force`; `bin/reset-db` is the intended "start the main DB over" path.
