# Architecture

claude-assist is a **toolkit**, not a deployment. It ships the substrate for a
personal assistant backend — ingestion, classification, dispatch, rendering — and
each operator runs their own instance. Nothing about any particular owner, their
data, their contacts, their schedule, or their private systems is in this repo;
records enter an instance only through module APIs at runtime, and instance
configuration enters only through env vars and file paths those env vars point at.

## Shape

One long-lived host process (Fastify on Bun) with PostgreSQL behind it. Modules
are Fastify plugins registered onto that host, each owning a Postgres schema and
its own migrations. There is no service mesh, no message broker, and no worker
fleet: recurring work runs on an in-process scheduler, and durability comes from
the database rather than from a queue product.

```
apps/server/          Fastify host: env schema, plugin registration, routing
apps/admin/           Single-page admin UI served by the host
packages/core/        Shared substrate + the contracts modules depend on
packages/<module>/    One Fastify plugin each, schema-per-module
skills/<skill>/       Agent-facing skills, each bundling a self-contained AXI CLI
```

**Why one process.** The alternative — splitting API and workers — buys
independent scaling and buys it at the cost of a second deploy target, a second
config surface, and a class of "which half is broken" incidents. An instance
serves one person. The concurrency safety that a worker split provides
incidentally is provided here deliberately, by database-held leases and advisory
locks, which are correct under both one process and several.

## Layering rules

**`packages/core` holds substrate and contracts; it holds no module logic.**
Contracts are the important half: when one module needs a capability another
module implements (notification dispatch, action ledgering, model invocation,
approvals, session spawning), the *interface* goes in core and the
*implementation* stays in its own package. Consumers depend on core, never on
each other. This is what keeps the dependency graph a star instead of a web, and
it is what lets a test inject a stub without importing a plugin.

**Modules do not read `process.env`.** Every environment variable is declared,
typed, defaulted, and documented in the host's env schema, then passed down as a
plain config object when the plugin is registered. A module that reads the
environment directly is undocumentable and untestable; a module that receives
config is both.

**Schema per module.** Each module owns a Postgres schema and numbered
migrations under its own package, run at registration. Cross-module reads go
through the owning module's API, not across schemas.

**Plugins are unencapsulated.** Decorators registered by one plugin are visible
to every plugin registered after it, so **registration order in the host is
load-bearing**: contracts-providing modules (ledger, notify, invoker, approvals)
register before their consumers.

## Model invocation

Every metered model call in the system routes through **one module** — the
invoker (`specs/modules/invoker.md`). Model ids are never written at a call
site; a caller names a **tier** describing the job, and the tier→model map is the
only place a model id appears. The invoker owns retries, timeouts, budgets, and
spend accounting, so a provider policy, pricing, or format change is a one-module
adaptation rather than a fifteen-file migration.

**The billing boundary is architectural.** Metered API credentials belong to
background work and to nothing else. Any path that warms or drives an
*interactive* session a human is steering must run on that human's own
credentials, and must actively strip service credentials from anything it
spawns. The invoker is the metered side of that boundary and must never become
a route across it.

## Background work

Recurring work registers with the host scheduler as a named cron task. Every
scheduled task runs under a **Postgres advisory lock keyed on its name**, which
makes a task safe against both a second host instance and against overlapping
with its own previous run (including a manual trigger firing alongside a
scheduled one).

Work that is *claimed* rather than merely *swept* — rows a worker takes
ownership of and processes — uses **lease semantics**: an atomic claim under
`FOR UPDATE … SKIP LOCKED`, a lease with an expiry, renewal for long work,
reclaim of expired leases, an attempt cap, and backoff between attempts. See
`specs/behaviors/scheduled-work-leases.md`.

## Human approval

Some actions must terminate in a human. Those go through the approvals module
(`specs/modules/approvals.md`), whose central rule is that **no code path ever
blocks waiting for a person**: a request is recorded, a notification is
dispatched, and the caller returns. Resolution is a separate, later event.

## Delivery

Notifications leave the system through one dispatcher with earned-interrupt
priority tiers (`interrupt` reaches a device immediately; `digest` batches).
Every pipeline that can silently fall behind registers a heartbeat with a
staleness threshold, and staleness itself notifies — the absence of success is
alerted on, not only the presence of errors.

## Agent-facing tooling

Capability that an agent uses is shipped as a **skill bundling a self-contained
AXI CLI**, built from TypeScript in the owning package and committed as a bundle,
with a CI drift guard. Skills are installed with the `skills` CLI, not as a
plugin marketplace. The CLIs speak to the same HTTP API as everything else and
add no privileged path.

## Testing

Tests run under `bun test` and **never require a live database or a live model**.
Persistence is faked with in-memory stores; model behavior is tested by exporting
the parse and prompt-construction logic as pure functions and by depending on
narrow interfaces (`Estimator`, `LabelParser`, `PrepComposer`, `ModelInvoker`, …)
that tests satisfy with stubs. Any new capability must preserve those seams.
