# SessionStart hooks: install / uninstall / status, project vs global

A bundled AXI CLI earns its keep when every agent session opens already knowing the relevant
state — without the agent invoking anything. You get that by registering a `SessionStart` hook
that runs your CLI's cheap home (or dashboard) view and injects its output as initial context.

This doc covers the `hook` command, the **project vs global scope** distinction, and — the part
the upstream `axi` skill doesn't go deep on — **project-level hooks and extended dashboards** for
skills installed into a specific repo.

Template/reference implementation: see specops `src/cli/commands/hook.ts` (the cleanest version);
a richer variant adds payload selection + entity dashboards on the same foundation (below).

## The `hook` command shape

Manage hooks explicitly — don't rely on the SDK's auto-install (it no-ops on `.mjs` names; see
SKILL.md gotchas). Three verbs:

```
mytool hook install   [--scope project|global] [--dir <path>] [--dashboard] [<entity-refs>...]
mytool hook uninstall [--scope project|global] [--dir <path>]
mytool hook status
```

All three build on the SDK's `computeSessionStartHookUpdate(settings, { marker, command, timeoutSeconds })`,
which is idempotent — repeated installs with the same command are silent no-ops. Match your own
hook entries by a `marker` (your tool name) so `uninstall` removes *only* yours and leaves the
user's other hooks (gh-axi, chrome-devtools-axi, …) untouched. `status` reports which payload is
installed where.

Why hand-roll this on top of `computeSessionStartHookUpdate` rather than the SDK's
`installSessionStartHooks()`? Because the latter is global-only, multi-agent, and writes
`$HOME/.claude` + `$HOME/.codex` + OpenCode. The skill-bundled case needs **project scope**,
**Claude-Code-only**, and a **target-dir override** — none of which the high-level helper offers
(this is item #1 in [kunchenguid/axi#46](https://github.com/kunchenguid/axi/issues/46)).

## Global scope — every session, any repo

Written to `~/.claude/settings.json`. Per-machine, never committed, fires in every repo. The hook
command is the **absolute path** of the installed shim, resolved from the bundle's own location:

```ts
function shimPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "mytool");
}
// global hook command:
JSON.stringify(shimPath())
```

An absolute path is correct here precisely *because* the hook fires in repos that don't vendor
your skill — a project-relative path would dangle. The shim self-locates wherever the global skill
is installed (`~/.agents/skills/<name>/scripts/mytool`, with `~/.claude/skills/<name>` symlinked).

This pairs with a **lean home view** (identity + reference, no live data) — see
`references/home-vs-dashboard.md`. It loads on *every* session, so it must be cheap and never error.

## Project scope — one repo, committed, portable

This is the extended concept that matters when **installing an AXI-powered skill at the project
level**.

> **Not in the SDK — you implement this yourself.** Project-scoped hook install is filed upstream
> as [kunchenguid/axi#45](https://github.com/kunchenguid/axi/issues/45) but is **not yet baked into
> `axi-sdk-js`**. The SDK's `installSessionStartHooks()` is global-only and multi-agent. Until #45
> lands, the project-scope path below is hand-rolled on top of the lower-level
> `computeSessionStartHookUpdate()` — this section is that recipe. Re-check #45 before building;
> if it has shipped, prefer the SDK primitive.

Written to `<repo>/.claude/settings.json`, which is **committed** — so every contributor
and CI machine gets the hook. That forces two requirements:

1. **The command must be portable across machines** — no absolute, machine-specific paths.
2. **It must resolve to the skill as vendored in *this* repo.**

The answer is a `${CLAUDE_PROJECT_DIR}`-relative path to the vendored skill's shim (the
`.claude/skills/<name>` symlink that the project install creates):

```ts
const PROJECT_HOOK_COMMAND =
  '"${CLAUDE_PROJECT_DIR}/.claude/skills/mytool/scripts/mytool"';

function hookCommand(scope: Scope): string {
  return scope === "global" ? JSON.stringify(shimPath()) : PROJECT_HOOK_COMMAND;
}
```

- `${CLAUDE_PROJECT_DIR}` is expanded by Claude Code at hook time to the repo root → portable.
- Quoted so a project directory containing spaces is safe.
- The project base for *writing* the settings file is the explicit `--dir`, else the git repo
  root (`git rev-parse --show-toplevel`); error clearly if neither resolves.

Make **project the default scope** when the tool is fundamentally about the current repo's state
(specops reads `./plans`): `hook install` with no flags should do the common thing.

### Hooks stack — global + project both fire

Claude Code runs SessionStart hooks from **both** user and project settings, additively. So a
session opened in a repo that has a project hook gets: the **global home** view (identity +
reference, injected once) **plus** the **project dashboard** view (live state) — stacked. Design
for this: the project dashboard should *omit* the command reference, because the global home hook
already injected it that session. Two complementary, non-duplicative payloads.

## Payload selection: home vs dashboard vs entity

A hook shouldn't be limited to the zero-arg home view. Let `hook install` choose what the hook
runs (item #2 in axi#46):

- **default → `home`**: lean identity + reference. Best as the global, every-session hook.
- **`--dashboard` → `dashboard`**: live situational state. Best as a project hook.
- **`<entity-refs>… [--related]` → entity dashboard**: pin the hook to specific entities so a repo
  opens already oriented to the engagement it's about (see below).

Because `runAxiCli` rejects flags *before* a command and the home view is strictly zero-arg, a hook
can't pin context with `home --dir x`. Instead, the hook relies on the SessionStart working
directory (cwd = repo root) to scope itself, or it runs a subcommand that *does* accept the
parameters (`dashboard project:x`). Keep this in mind when designing what the hook runs.

## Extended / entity dashboards for project installs

When a skill is installed at the project level, the most valuable session-start context is often
*"what is this repo's engagement about"* — not generic personal state. That's the **entity (or
extended) dashboard**: a payload that blends one or more specific entities into a focused
situational view.

A proven model, generalized:

- `dashboard <type:slug> [<type:slug>…] [--related]` resolves a set of focal entities and renders a
  **blended** view: the focal entities, their merged open items (commitments/tasks), a merged
  chronological activity feed, and the surrounding identifier neighborhood. `--related` does a
  one-hop expansion across foreign keys to pull in neighbors.
- Install it as a **project-pinned hook** so the repo opens oriented to exactly that work:

  ```
  mytool hook install --scope project project:acme proposal:q3 org:transit --related
  ```

  Now every session in that repo starts knowing the project, its proposal, and the org, with their
  open commitments and recent activity already in context.

Design principles for the extended dashboard (these are where project-level dashboards go wrong):

- **Comprehensive in coverage, bounded in depth.** Cover every relevant section, but cap each
  (top-N + truncation + a drill-down pointer) — never dump everything. Session-start context loads
  every time; it must stay token-disciplined even while being broad.
- **Order sections by ambient value.** The most useful orientation first (who/what this is, the
  identifiers an agent will need before it asks), because the tail is what gets cut when context is
  trimmed. Hand the agent identifiers up front so it doesn't have to look them up.
- **Drop redundant columns per surface.** A personal dashboard can omit `assignee` (everything is
  yours); an entity dashboard keeps `assignee` (it shows anyone's). Tune each payload to its
  surface rather than reusing one schema everywhere.
- **Do personalization server-side.** Fold "where you left off" into the data endpoint itself
  (it already knows the user) so the CLI makes **one** call. Don't fake it with extra CLI round
  trips (thin client / server-authoritative).

## Gotchas

- **`os.homedir()` ignores `$HOME`.** You can't sandbox global-hook install by faking `$HOME` —
  it writes to the real `~/.claude/settings.json`. Test by installing against the real path then
  immediately uninstalling, asserting the user's other hooks survive.
- **Match by marker, filter precisely.** On `uninstall`, filter `SessionStart` hook entries to
  those whose `command` includes your marker, then drop now-empty groups. Verify other tools'
  hooks are preserved.
- **Wire the CI drift gate to actually run** — it's easy to claim `check` runs in CI while the
  workflow only runs `tsc`. A stale bundle then passes silently. Confirm the workflow runs
  `bun run check`.
