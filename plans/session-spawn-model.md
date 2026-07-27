---
status: in-progress
depends: [session-spawn]
specs:
  - specs/modules/session-spawn.md
  - specs/modules/kitchen.md
issues: []
pr:
---

# Plan: spawned sessions always name their model explicitly

## Scope

Give every spawned Remote-Control session an **explicit model**, resolved as
caller override → instance default → omitted, and hand it to the spawn command
as `SESSION_SPAWN_MODEL` in the child environment (the same mechanism
`SESSION_SPAWN_GROUP` already uses).

- `SESSION_SPAWN_MODEL` — new env, schema default `opus`.
- `SpawnRequest.model?` — per-caller override, validated like `group`.
- `KITCHEN_PLAN_SESSION_MODEL` — the meal-planning caller's override; unset ⇒
  the instance default.

Observed in use: a meal-planning session spawned from the kitchen app came up on
whatever model was selected as the interactive default at the time. Model
selection was simply never expressed anywhere in the chain, so the session's
capability was a side effect of the owner's last `/model` pick.

Also tightens the command contract in the spec: the spawn command must be fully
non-interactive, because a blocking first-run prompt (folder trust, a new
integration, a tool permission) surfaces here only as a timeout with no link.
Pre-empting those prompts is the wrapper's job — the wrapper change itself is
instance data and lives outside this repo.

**Out of scope:**

- The metered per-module model settings (`KITCHEN_ESTIMATION_MODEL`,
  `KITCHEN_RECEIPT_MODEL`). Different axis entirely — those are the service's own
  API calls; this is the model an interactive human session runs on under
  subscription auth.
- Any change to how the spawn command is discovered or invoked (argv contract,
  temp-file handoff, timeout, auth stripping) — all unchanged.
- Validating that a named model actually exists. The session tool owns that; a
  bad name fails at launch, which is a spawn failure like any other.

## Implements

- `specs/modules/session-spawn.md` § Model selection — resolution order,
  validation rule, `SESSION_SPAWN_MODEL` on the child env, and the
  `SpawnRequest.model` field.
- `specs/modules/session-spawn.md` § Spawn command contract — the
  non-interactive requirement.
- `specs/modules/kitchen.md` § Plan-session → Model — the
  `KITCHEN_PLAN_SESSION_MODEL` override and its separation from the metered
  kitchen models.

## Approach

- **`packages/core`** — add `model?: string` to `SpawnRequest`, and
  `planSessionModel?: string` to `KitchenPluginConfig`.
- **`packages/session-spawn`** — `MODEL_ID_RE` +
  `isValidSpawnModel()` alongside the existing group validator;
  `SessionSpawnerConfig.model` validated once at construction (malformed ⇒ warn +
  treat as unset); per-spawn resolution with an invalid caller value degrading to
  the instance default; `sanitizedSpawnEnv(group, model)` sets
  `SESSION_SPAWN_MODEL` — and **deletes** it when resolution produced nothing, so
  the service's own env value can never leak through as the session's model.
- **`packages/kitchen`** — thread `planSessionModel` into
  `registerPlanSessionRoutes` and pass it as `spawn({ ..., model })`.
- **`apps/server`** — `SESSION_SPAWN_MODEL` (default `opus`) and
  `KITCHEN_PLAN_SESSION_MODEL` (optional) in the env schema; wire both;
  document in `.env.example`.
- Log the resolved model on a successful spawn (config, not a secret) — it's the
  one detail worth having when a spawned session behaves oddly.

## Validation

- [x] Instance default reaches the child env as `SESSION_SPAWN_MODEL`.
- [x] A caller's valid override wins over the instance default.
- [x] An invalid caller override (whitespace, shell metacharacters, leading
      dash, over-length) is warned about and falls back to the instance default;
      the spawn still succeeds.
- [x] With neither default nor override, `SESSION_SPAWN_MODEL` is **absent** from
      the child env even when the service's own env carries a stray value.
- [x] A malformed instance default warns at construction and is treated as unset.
- [x] `bun test packages/session-spawn/src` green; `bun run build` green.
- [ ] End-to-end: a real spawn from the app comes up on the configured model.

## Risks / unknowns

- **Alias vs. pinned name.** The default is the alias `opus`, so the tier tracks
  the latest model without a config edit — and shifts underneath the instance
  when a new model ships in that tier. That's the intent; an instance wanting
  stability pins the full name.
- **The wrapper must honor the variable.** A wrapper that ignores
  `SESSION_SPAWN_MODEL` silently keeps the old sticky-default behavior with
  nothing in the logs to say so. The success log line naming the resolved model
  is the tell to check against what actually launched.

## Notes

- Passing the model via the **child env**, not argv, is deliberate: the argv
  contract reserves the final slot for the preload-prompt path, and `group`
  already established env as the channel for per-spawn metadata.

## Follow-ups

- None.
