# Module: Invoker

The **single choke point for every metered model call in the system**. No other
module constructs a provider client, names a model id, implements a retry loop,
or decides whether a call is affordable. A caller describes the *job* — a stable
task id, a tier, a token ceiling, and messages — and gets back text plus an
honest accounting of what it cost.

The point is not abstraction for its own sake. It is that a provider policy
change, a pricing change, a model deprecation, or a decision to stop spending
should be **one module's edit**, not a hunt across every package that happens to
classify something.

## What routes through it, and what must not

**Through it:** every headless or scheduled model call — classification, parsing,
extraction, summarization, synthesis, vision. These run on the instance's
**metered API credential** and are engineered cheap.

**Not through it, ever:** any path that warms or drives an *interactive* session
a human is steering. Those run on that human's own credentials. The interactive
session spawner actively **deletes** the service's API key and OAuth token from
the environment of anything it spawns, and the conversational agent path
deliberately authenticates with an OAuth token rather than the metered key. The
invoker is the metered side of a boundary; it must never become a route across
it. A change that lets an interactive workload reach the invoker is a bug even
if every test passes.

## Tiers, not model ids

A caller names a **tier**, which describes the shape of the work:

| Tier | For | Default class |
| --- | --- | --- |
| `classify` | Short verdicts over short inputs — is this urgent, what type is this, does it match | Cheapest adequate |
| `extract` | Structured extraction from a long or messy input — parse this receipt, pull these events out of a transcript | Cheapest adequate |
| `vision` | Anything with images attached | Cheapest adequate that sees |
| `synthesize` | Drafting and narrative over a whole batch, run once per batch | Strong |

The tier→model map is the **only place a model id is written**. Each tier is
overridable by env (`MODEL_TIER_CLASSIFY`, `MODEL_TIER_EXTRACT`,
`MODEL_TIER_VISION`, `MODEL_TIER_SYNTHESIZE`), and a caller may pass an explicit
`model` to pin one call site — but the pin is an exception that has to justify
itself, not the default. Naming the job rather than the model is what lets the
mapping move for everyone at once.

## The call

```ts
invoke({ task, tier, maxTokens, system?, messages, model?, cacheSystem?, timeoutMs? })
  → { text, model, tier, stopReason, usage, attempts, durationMs }
```

- **`task`** is a stable dotted id (`google.triage`, `kitchen.receipt`). It is
  the grain of every spend query and every per-task budget, so it must not
  encode anything variable.
- **`messages`** is an array, not a single prompt, so the one genuinely
  conversational caller needs no special case, and so the tagged-parse retry
  below can append a correction turn.
- **`cacheSystem`** places an explicit prompt-cache breakpoint on a long static
  system prompt. High-frequency classifiers with a large fixed preamble should
  set it; short prompts should not, because a breakpoint below the provider's
  minimum is wasted.

### Tagged structured output

Twelve call sites independently implemented the same loop: wrap JSON in an XML
tag, extract with a regex, `JSON.parse`, validate, and on failure append the bad
assistant turn plus an `<error>` user turn and ask once more. That loop belongs
here:

```ts
invokeTagged({ …invoke fields, tag, parse, parseRetries? }) → T
```

`parse` throws to signal "the model got the shape wrong"; the invoker appends
the correction turn and retries **once by default**. A second failure is
terminal with `reason: 'parse_failed'`. The retry is deliberately not
generous — a model that fails the shape twice will usually fail it five times,
and every attempt is billed.

Deliberately **not** used: provider-side structured-output/JSON-schema modes.
Tagged text keeps the module portable across models and keeps the parse logic a
pure function the tests can exercise without a model.

## Retries, timeouts, and failure

The provider SDK's own retry is **disabled**; the invoker owns the policy so it
is observable and so a retry lands in the spend ledger.

- Transport failures are classified **retryable** (`429`, `5xx`, connection
  reset, timeout) or **terminal** (`400`, `401`, `403`, a refusal stop reason).
  A terminal failure never burns a second attempt.
- Retryable failures back off exponentially with jitter, honoring a
  `retry-after` header when one is present.
- Every call has a wall-clock timeout with a per-tier default. A hung classify
  must not hold a concurrency slot for the provider SDK's ten-minute default.

Failures raise a single error type carrying `reason`, `task`, `retryable`, and
`transient`. **`transient` is the important one:** it marks failures that are
the *system's* fault rather than the work item's — the kill switch, a budget
breach, a disabled invoker. A pipeline must not count a transient failure
against a row's attempt cap, or one exhausted budget permanently poisons a
backlog it never got to look at.

## Spend accounting

Every invocation — including each retry — appends a row: task, tier, model,
input/output/cache-write/cache-read tokens, estimated cost, duration, attempt
number, outcome, and error reason. Nothing is aggregated at write time.

Cost is estimated from a price table that lives beside the tier map and is
overridable by config. An estimate that is stale by a price revision is still
enormously more useful than the previous state of the world, which recorded
nothing at all — `usage` was never read at a single call site.

`GET /api/invoker/spend` returns the current window: totals, per-task breakdown,
the configured budget, whether the kill switch is on, and whether an overage is
currently approved.

## Budgets

Two ceilings over a rolling daily window: a dollar ceiling and a token ceiling,
either of which may be unset. Optionally a per-task dollar ceiling map, for
pinning one noisy pipeline without constraining the rest.

The window total is held in memory, seeded from the ledger at startup and
re-read periodically, so the common path costs no query.

**A breach does not silently stop the instance.** It raises a human approval
request (see `specs/modules/approvals.md`) describing what was spent and on what,
and fails the call with `reason: 'budget_exceeded'`, `transient: true`. If a
human approves the request, the approved overage amount raises the effective
ceiling for the remainder of the window and work resumes on its own. If nobody
answers, the request expires and the instance stays stopped — which is the
correct failure direction for money.

Exactly one request is raised per window per scope; the approvals module's
deduplication key does that, so a stuck sweep running every minute cannot
generate a notification every minute.

## Kill switch

One flag (`MODEL_KILL_SWITCH`) stops all metered invocation while leaving the
host healthy and every non-model path working. It fails calls as `transient`,
for the same reason a budget breach does. Per-feature disable flags remain —
they answer "turn this pipeline off"; the kill switch answers "stop spending,
now, everywhere."

## Degradation

With no API credential the invoker is **disabled**: `enabled` is false, and the
host does not construct the model-backed services at all — the same graceful
path those services already had for a missing key. Nothing throws at boot, and
every feature that has a deterministic fallback keeps working on it.

## Applies To

Every package that calls a model. A `new Anthropic(…)` outside this module — or
a bare model-id string literal anywhere but its tier map — is a defect, and the
one exception (the interactive path described above) is an exception because it
must **not** touch the metered credential, not because it is allowed to
duplicate the invoker.

## Principles

**Inherited** — from [principles.md](../principles.md):

- [Single invoker, honest billing](../principles.md#single-invoker-honest-billing)
- [Gather cheap, judge expensive](../principles.md#gather-cheap-judge-expensive) —
  the tier map is where that judgment is expressed once.
- [Degrade, don't fail](../principles.md#degrade-dont-fail)
- [Never block on a human](../principles.md#never-block-on-a-human) — a budget
  breach raises an approval and returns; it does not wait for one.
