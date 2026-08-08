---
status: in-progress
depends: [harmonization-survey]
specs:
  - specs/modules/invoker.md
issues: []
---

# Plan: Single model invoker with tiering, budgets, and spend accounting

## Scope

Build the invoker module and route **every metered model call** through it.
Before this, fifteen call sites across six packages each constructed their own
provider client, wrote their own model id, and relied on the SDK's default
retries; six of them had no environment override at all, none recorded a single
token of usage, and nothing anywhere enforced a budget.

**Out of scope**: the two paths that must *not* use the metered credential — the
interactive session spawner (which strips service credentials from its child)
and the conversational agent (which authenticates as a human). Those are
invariants to preserve, and the spec says so.

## Implements

- **specs/modules/invoker.md** — tiers, the tagged-parse loop, retry/timeout
  policy, spend accounting, budgets, kill switch, degradation.
- **specs/principles.md § Single invoker, honest billing** and
  **§ Gather cheap, judge expensive**.

## Approach

- Contract in `packages/core/src/invoker.ts` (types + error class only), so
  every consumer depends on core and takes a `ModelInvoker` it can stub, and no
  consumer depends on the implementation package. This is the established
  pattern for notify, ledger, and session-spawn.
- Implementation in `packages/invoker`: tier→model map and price table in one
  file, retry/backoff/timeout policy, prompt-cache breakpoints, vision content
  normalization (three duplicated media-type normalizers collapse into one),
  and the tagged-JSON parse-correction loop that twelve call sites had each
  written for themselves.
- Spend ledger table in schema `invoker`, one row per invocation **including
  retries**. Window totals held in memory, seeded from the ledger at startup,
  so the common path costs no query.
- Budget breach raises a deduplicated approval and fails the call as
  `transient` — the pipelines must not count a budget breach against a row's
  attempt cap.
- Refactor call sites mechanically: services take `invoker` in place of
  `apiKey`, keep their narrow interfaces (`Estimator`, `PrepComposer`, …) so
  existing stub-based tests keep working.

## Validation

- [ ] `packages/invoker` exists, decorates `fastify.invoker`, and degrades to
      disabled with no API credential.
- [ ] Zero `new Anthropic(` outside `packages/invoker` (the agent-SDK
      conversational path excepted — it is not a metered call).
- [ ] Zero model-id string literals outside the tier map and the env schema.
- [ ] Every invocation appends a spend row with tokens and estimated cost.
- [ ] Daily dollar and token budgets are enforced before the call; a breach
      raises one approval per window and fails `transient`.
- [ ] `MODEL_KILL_SWITCH` stops all metered invocation with the host healthy.
- [ ] Retries are the invoker's, not the SDK's: terminal errors never retry,
      retryable ones back off with jitter.
- [ ] `GET /api/invoker/spend` reports window totals, per-task breakdown,
      budget, and kill-switch state.
- [ ] `bun test` green; the interactive-path credential stripping is unchanged
      and still tested.

## Risks / unknowns

- **Migration disruption** — routing every model call through one module touches
  fifteen call sites in live pipelines. Mitigated by keeping each service's
  narrow interface intact so its existing tests are the regression net, and by
  changing wiring only at the plugin boundary.
- **Cost estimates drift** — a price table in code goes stale on a provider
  revision. Accepted: it is overridable by config, and a stale estimate is
  incomparably better than the previous state, which measured nothing.
- **We might delete this** — if the provider ships a first-class budget/routing
  layer, most of this module becomes a thin adapter. That is a good outcome and
  the tier map is where it would land.

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
