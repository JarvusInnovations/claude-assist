# Runtime divergence inventory

claude-assist grew organically: modules were added one at a time, each solving its
own model-invocation, retry, and background-work problems locally. A sibling
agent-runtime service — private, built later by the same authors, on a different
deployment substrate (managed containers + a dedicated worker service, where
claude-assist is a single long-lived host process) — solved the same problems once,
deliberately. This document is the survey that preceded backporting: every
divergence between the two, with an **adopt** or **skip** decision and the reason.

It is a point-in-time record, not a spec. Where an item was adopted, the durable
statement of behavior lives in `specs/` and the work in `plans/`.

Three ground rules shaped the decisions:

1. **Adapt, don't copy.** The reference runtime is horizontally scaled across
   ephemeral workers; claude-assist is one process on one host. Patterns whose
   only job is to survive that difference were skipped on purpose.
2. **Fix the gaps while backporting.** The reference runtime has known holes — no
   lease renewal, no retry backoff, an escalation `expired` state nothing ever
   sets. Adopting a pattern meant adopting the corrected version.
3. **Don't regress what's already better.** claude-assist is ahead of the
   reference on a few axes (the billing boundary, the derived action ledger).
   Those are recorded as invariants to preserve, not as gaps.

**Totals: 21 adopted, 13 skipped.**

---

## A. Model invocation

| # | Divergence | Reference runtime | claude-assist (before) | Decision |
| --- | --- | --- | --- | --- |
| A1 | **Single choke point for model calls** | No general LLM wrapper — all model mechanics delegated to an agent SDK, with one shared options builder | 15 independent `new Anthropic()` constructions across 6 packages, each with its own defaults | **Adopt, going further.** Neither side had a real invoker. Built `@jarvus/claude-assist-invoker` as the one hardened module every metered call routes through. |
| A2 | **Model tiering by task class** | Absent — one model string per agent template | Absent — 15 hardcoded model literals, 6 of them with no env override at all | **Adopt.** Tiers (`classify` / `extract` / `vision` / `synthesize`) name the *job*; the tier→model map is the only place a model id appears. |
| A3 | **Centralized model-id constants** | Absent — ids live in template frontmatter, unvalidated | Absent — bare string literals in 14 files plus 5 schema defaults | **Adopt.** Folded into A2: the tier map is the constants map. |
| A4 | **Token/usage accounting** | Per-message and per-turn `usage` JSONB, summed on demand | None. `response.usage` was never read at any call site | **Adopt.** Every invocation writes a row to a spend ledger with model, tier, task, tokens, cache hits, estimated cost, latency, and outcome. |
| A5 | **Budget enforcement** | Template-declared budgets enforced by the worker: max steps, wall clock, cumulative session tokens | None. The only levers on spend were concurrency limits and feature kill-flags | **Adopt, adapted.** No sessions here, so the budget is a rolling daily window — global and per-task, in both tokens and dollars — checked before each call. |
| A6 | **Price table / dollar accounting** | Absent — budgets are token-denominated only | Absent | **Adopt.** Honest billing needs a number in dollars, not tokens. Prices live beside the tier map and are overridable so a price change is a config edit. |
| A7 | **Transport retry with backoff** | Retries yes (attempt counter, cap 3), **backoff no** — a failed unit re-queues instantly | Relied entirely on the SDK's built-in 2 retries; no explicit policy | **Adopt with the gap fixed.** Explicit attempt cap, exponential backoff with jitter, and a retryable/terminal classification so a 400 doesn't burn three attempts. |
| A8 | **Explicit request timeouts** | Per-turn wall-clock abort | SDK default (10 minutes) everywhere | **Adopt.** A per-call timeout with a tier default; a hung classify call should not hold a concurrency slot for ten minutes. |
| A9 | **Structured-output parsing** | None — the one structured call does string cleanup | Uniform tagged-JSON + exactly one in-conversation parse-correction retry — **duplicated in 12 places** | **Adopt, from claude-assist's own side.** The existing pattern was good; it was just copied. Lifted into `invokeTagged()`. The reference runtime has nothing to contribute here. |
| A10 | **Prompt caching** | Deliberate but implicit: a byte-identical prefix each turn against the provider's content-keyed cache | None | **Adopt, explicitly.** Long static system prompts on high-frequency classifiers get an explicit cache breakpoint rather than relying on prefix luck. |
| A11 | **Structured error taxonomy** | `error` JSONB with a `reason` discriminator | Ad-hoc `Error` subclasses per module | **Adopt.** A single error type carrying `reason`, `retryable`, and the task id; the per-module parse errors stay, wrapped. |
| A12 | **Per-call correlation metadata** | DB-side only (worker id, turn id, attempts) | None | **Adopt.** Task id and attempt land on the spend row, so a spend spike is attributable to a module without reading logs. |
| A13 | **Kill switch as a drain** | An env flag makes workers claim nothing while staying healthy | Per-feature disable flags plus a master sync override — no single "stop spending" lever | **Adopt.** One flag disables all metered invocation; every consumer already degrades gracefully when the key is absent, so the drain reuses that path. |
| A14 | **Interactive vs. metered credential boundary** | Not applicable — one credential, one workload | **Already stronger.** The interactive-session spawner explicitly deletes API-key and OAuth-token env vars from its child, and the chat agent deliberately runs on an OAuth token rather than the metered key | **Skip — preserve.** Recorded as an invariant the invoker must not erode: the invoker owns *metered* calls only, and must never become a path by which a human-driven interactive session runs on service credentials. |
| A15 | **Multi-turn conversation state** | The whole runtime is conversational | One call site only (email triage's two-turn analysis) | **Adopt into the invoker's shape.** The invoker carries a message array rather than a single prompt, so the one conversational consumer needs no special case. |
| A16 | **Vision / multimodal content** | Absent | Three call sites, each with its own duplicated media-type normalizer | **Adopt.** One normalizer in the invoker; the three copies collapse. |
| A17 | **Structured logger + metrics export** | `console.log` only; no metrics, no tracing | Fastify's structured logger already in place | **Skip.** claude-assist is ahead; the spend ledger supplies the one series that matters. A metrics exporter is a separate concern from this survey. |

## B. Background work: queueing and leases

| # | Divergence | Reference runtime | claude-assist (before) | Decision |
| --- | --- | --- | --- | --- |
| B1 | **Atomic claim (`FOR UPDATE … SKIP LOCKED`)** | Yes — the claim is one statement, queued → running | **None anywhere.** Five separate pipelines each do `SELECT … WHERE status = … AND attempts < cap LIMIT n` with no row locking | **Adopt.** Two concurrent sweeps would both select the same rows and both spend. |
| B2 | **Lease with expiry + reclaim** | Fixed TTL set at claim; a sweep reclaims expired work or fails it past the attempt cap | Only process-local in-flight flags (`inProgress`, `sweeping`, an in-flight map) — none survive a restart | **Adopt.** A crash mid-batch currently strands rows in a running state forever. |
| B3 | **Lease heartbeat / renewal** | **Absent** (a flagged gap): safety depends on the work finishing faster than the TTL by convention, or the same unit runs twice | Absent | **Adopt with the gap fixed.** `renew()` extends the lease for long-running work, so the TTL can be short without risking duplicate execution. |
| B4 | **Retry backoff (`next_attempt_at`)** | **Absent** (a flagged gap): a deterministically-failing unit burns its whole attempt budget in milliseconds | Absent — attempt caps only | **Adopt with the gap fixed.** Failure schedules the next attempt with exponential backoff; the claim query filters on it. |
| B5 | **Distributed cron lock** | **Absent** (a flagged gap): scheduled jobs run in the API process with no lock, so with more than one instance they fire more than once | **Absent, and worse:** no overlap prevention at all, and the manual-trigger route runs a handler concurrently with its scheduled run | **Adopt with the gap fixed.** Every scheduled task runs under a Postgres advisory lock keyed on its name, covering both multi-instance and overlap-with-itself. |
| B6 | **Per-key serialization via a partial unique index** | Yes — a unique index over the in-flight statuses guarantees at most one active unit per conversation while `SKIP LOCKED` still gives cross-key parallelism | Absent (and not needed by every table) | **Adopt as a documented technique.** The lease helper supports it; it is applied where a table has a natural serialization key, not blanket. |
| B7 | **`LISTEN`/`NOTIFY` enqueue + sweep as the correctness backstop** | Yes, with the notify deliberately INSERT-only so re-queues ride the sweep | Cron sweeps only, as fast as every minute | **Skip.** The design is excellent, but its payoff is sub-second dispatch latency on a horizontally-scaled worker fleet. On a single host with minute-cadence sweeps there is nothing to buy, and a durable listener is a new failure mode. Revisit if a pipeline ever needs sub-minute latency. |
| B8 | **Dedicated worker process** | A separate always-on worker service, API and execution split | In-process scheduler inside the API host | **Skip.** The split exists to let the two scale independently on a managed-container substrate. On one host it buys nothing and doubles the deploy surface. The advisory locks in B5 give the safety the split was providing incidentally. |
| B9 | **Dead-letter queue** | Absent — exhausted units sit at `failed` with error JSON | Absent — same shape | **Skip.** Both landed in the same place independently, which is evidence it's adequate at this volume. `failed` + structured error + a queryable attempt count is a dead-letter queue without the extra table. |
| B10 | **Idempotency keys for partially-completed work** | Absent, and explicitly flagged as unresolved: a crashed worker's partial writes are neither marked superseded nor rolled back | Absent | **Skip.** Genuinely unsolved on both sides; adopting nothing is honest. The lease reclaim in B2 at least makes the re-execution *visible* rather than silent. Tracked as a follow-up. |
| B11 | **Disposable execution state** | Fresh temp working directory per unit, recursively removed in a `finally`; everything durable is written through an API before the unit is acked | **Already equivalent** where it applies: the session spawner already uses a temp dir with `0600` mode and a `finally` cleanup | **Skip — preserve.** No divergence to close. |

## C. Human approval and escalation

| # | Divergence | Reference runtime | claude-assist (before) | Decision |
| --- | --- | --- | --- | --- |
| C1 | **A first-class escalation record** | A dedicated table: kind, payload, status, resolution, resolver, timestamps | Three unrelated per-module hold states (staged email actions awaiting confirm, captures held for review, inventory items needing info). No shared abstraction, and nothing at all gating model *spend* | **Adopt, generalized.** One approvals module the whole host shares. The three existing per-module holds stay as they are — they're domain workflow states, not generic approval gates — but new gates use the shared one. |
| C2 | **Escalation-as-abort (never block on a human)** | The worker records the escalation, releases everything, and marks the unit escalated; a fresh unit is enqueued when the human resolves | Not applicable — nothing escalated | **Adopt.** The single most important idea in the reference design. `request()` returns immediately with an id; no code path ever awaits a human. |
| C3 | **How the human finds out** | Server-sent events into a web UI. No push, no email — a pending approval is invisible unless someone has the page open | **Already stronger:** a push dispatcher with earned-interrupt priority tiers and a digest fallback | **Adopt the record, replace the channel.** Approvals dispatch through the existing notify spine, so a pending approval reaches a phone instead of waiting on an open browser tab. |
| C4 | **Expiry of pending approvals** | `expired` exists in the schema and **nothing ever sets it** — a pending escalation blocks its session indefinitely | Not applicable | **Adopt with the gap fixed.** Approvals carry an expiry and a sweep enforces it, so a request that never gets answered fails closed rather than hanging. |
| C5 | **Resolve API (approve / deny / answer)** | A REST resolve endpoint doing validation, state transition, transcript append, and continuation enqueue in one transaction | Absent | **Adopt.** Same shape, minus the continuation enqueue (no conversation to continue). Conflict on an already-resolved request returns 409, as in the reference. |
| C6 | **Approval is re-checked on every attempt** | **Not** re-checked — an approved action re-escalates if invoked again, an explicitly flagged rough edge | Not applicable | **Skip the flaw.** An approval here resolves a specific request id; the requester consults that id. There is no "the model might try again" ambiguity because there is no autonomous loop. |
| C7 | **Tool-permission callback as the escalation sink** | The agent SDK's permission callback intercepts declared high-risk tools | Not applicable — metered calls are plain completions with no tools | **Skip.** No tool surface to gate. The equivalent gates here are on *actions* (applying Gmail changes, routing captures), which already have their own confirm-to-execute paths. |
| C8 | **Live event fan-out to a session UI** | An SSE hub with per-kind resume semantics | Absent | **Skip.** No live conversational UI. The rendered-pages module plus push notification is the surface, and it doesn't need streaming. |

## D. Identity, provenance, and deployment

| # | Divergence | Reference runtime | claude-assist (before) | Decision |
| --- | --- | --- | --- | --- |
| D1 | **Agent behavior as reviewed code, not runtime data** | Agent templates are committed files loaded into a frozen registry; a session can't widen its own authority, only a merged change can | **Already equivalent.** System prompts are module constants; the one instance-specific prompt is loaded from a path given by config and never committed | **Skip — preserve.** Same invariant reached by a different route. |
| D2 | **Deterministic provenance** | An env var forces a CLI to auto-attach a source to every write, so the model cannot forget to cite | **Already stronger.** The derived action ledger extracts actions from ingested tool calls after the fact — deterministic and not dependent on the tool cooperating | **Skip — preserve.** |
| D3 | **Bot identity modeled as a first-class actor** | Bots are records in the contacts table with a system flag, so one authorship model covers humans and bots | Not applicable — single-user by design | **Skip.** |
| D4 | **Secret bootstrap ordering** | Placeholder secret versions seeded by IaC so a service can always start before real credentials exist | Not applicable — env file on a single host | **Skip.** Substrate-specific. |
| D5 | **Health endpoint reporting worker state** | Reports active units, concurrency cap, and kill-switch state | A bare health check | **Adopt, narrowed.** The spend snapshot and kill-switch state are exposed on the invoker's own route rather than bloating `/health`. |

---

## Follow-ups this survey deliberately deferred

- **Idempotency for partially-completed work** (B10) — unsolved on both sides.
- **Adopting the lease helper across all five sweep pipelines** — one pipeline was
  migrated to prove the pattern end-to-end; the rest keep their attempt-capped
  sweeps until each is touched for other reasons. The advisory lock (B5) closes
  the concurrency hole for all of them in the meantime.
- **`LISTEN`/`NOTIFY` dispatch** (B7) — revisit if any pipeline needs sub-minute
  latency.
- **Metrics export** (A17) — the spend ledger is queryable; a scrape endpoint is a
  separate concern.
