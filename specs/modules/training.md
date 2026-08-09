# Module: Training

A weekly adaptive training plan, synthesized from what the owner actually did
rather than from what a plan drawn months ago said they would do, proposed for
asynchronous approval, and rendered a day at a time into the daily briefing.

The module is sport-agnostic and goal-agnostic. It knows how to lay out *a week
of sessions* against three constraints — recent activity, the forecast, and the
calendar. What the owner is training for is instance data (`goalContext`), and
no athlete, race, or training philosophy is committed here.

## Why a weekly batch and not a daily check-in

Training plans that demand a daily input die. The adaptation happens once a
week, on a schedule, with a heartbeat; the daily surface is read-only. A week
nobody looks at costs one pending approval row and a staleness alert — never a
stalled pipeline and never a chore.

## The week

A plan covers one Monday-to-Sunday week in the module's configured zone
(`timeZone`; unset means a UTC week, which is correct and obviously not what
anyone who meant a local week wanted). Week arithmetic is done on `YYYY-MM-DD`
strings in UTC, never on `Date` instances in the machine's zone — that is what
keeps a job running at 23:00 from planning tomorrow's week, and what makes the
math immune to DST.

Every day of the week gets a session entry, **including rest days**. A rest day
is a decision; saying it out loud is what stops it from being an accident.

## Inputs

Three sources, each of which degrades to a flagged error rather than throwing:

| Source | Boundary | Absent ⇒ |
| --- | --- | --- |
| Activity history | `ActivityHistoryProvider` (core contract) | planned without history |
| Forecast | Provider daily-forecast API over `fetch` | planned without a forecast |
| Calendar availability | The briefing module's `gws-axi calendar events` read | planned without the calendar |

**An unavailable source is stated in the prompt as unavailable, never omitted.**
A section that silently vanishes reads to a model as "nothing to report", which
is the opposite of what a missing forecast means.

### Why activity history arrives through a seam

The provider whose history is read rotates its refresh token on every refresh,
so an instance can have exactly **one** rotator per upstream OAuth app. The
module that owns those credentials also owns token custody and exposes the read
behind core's provider-agnostic `ActivityHistoryProvider`; the host composes it
into this module's config. A second module holding its own refresh token for
the same app would invalidate the first one's stored token on its first
refresh, and vice versa.

### Why the calendar read is borrowed, not duplicated

The briefing module already exports a `gws-axi calendar events` boundary with a
tested TOON parse. Training imports it. The dependency runs **one way**: the
briefing's training source reads `training.week_plans` over SQL (the
sibling-schema pattern its other sources use) rather than importing back, so
the packages don't cycle.

## Synthesis

One metered model call per week, on the `synthesize` tier, through
`fastify.invoker` (`specs/modules/invoker.md`). Task id: `training.weekly-plan`.
The answer is a tagged JSON payload validated against the week that was asked
for — a plan naming days outside its own week is rejected, which buys the one
correction turn `invokeTagged` provides.

**There is deliberately no deterministic fallback plan.** A meeting prep can
degrade to a mechanical assembly and still be useful; a training week nobody
reasoned about is worse than no week, because it would be proposed for approval
as though it had been. Without a metered credential the weekly job **preflights
and exits clean**, writing nothing and asking nothing.

## Approval: proposed, never imposed

A generated week is born `proposed`. The job raises exactly one approval
(`kind: training_week_plan`, deduped on `training:week:<weekStart>`) at `notice`
priority and **returns immediately** — escalation-as-abort
(`specs/modules/approvals.md`). No code path here ever awaits a human.

A separate short-cadence pass reconciles:

| Gate outcome | Plan becomes | Effect |
| --- | --- | --- |
| approved | `active` (any prior active week for the same date range → `superseded`) | renders in the briefing |
| denied | `rejected` | the previously active week stands |
| expired / cancelled | `expired` | fails **closed** — nothing renders |
| still pending | unchanged | nothing renders yet |

Two partial unique indexes hold the invariants: at most one `active` and at most
one `proposed` plan per week. Activation supersedes in one transaction, so it is
an invariant rather than a race.

**Only an `active` week renders.** Showing a `proposed` week in the briefing
would quietly convert an async gate into a fait accompli.

When no approvals module is loaded at all, the week activates with a loud
warning — the alternative is a plan that can never be reached.

## Briefing integration

The briefing's training section carries today's session (its shape, its detail,
and the one line of *why*), the week's headline, and a short look-ahead. The
section is **omitted entirely** when no week is active: an instance that doesn't
run this module should not see a "not available" bullet every morning.

One line renders whether or not a week is active: a `proposed` week awaiting
approval. That is how a forgotten gate becomes visible without a second
notification.

## Coverage

Pipeline `training-plan`, registered up-front with a weekly-plus-slack threshold
(`staleAfter`, default `9 days`), so a generation that never happens pages
rather than staying invisible until its first success. The heartbeat is beaten
only on a run that produced or found a week — a preflight exit is a real gap in
coverage and must page, not be papered over.

## Out of scope

- **Recovery telemetry beyond what the activity provider carries.** Body
  battery, stress, and HRV-class signals live behind an authenticated-session
  replay with no usable API. That is a periodic, human-adjacent analysis
  protocol on the agent side by design, and must never become an automated
  dependency of this loop.
- **Energy expenditure.** The kitchen module's expenditure ledger owns it.
- **Writing back to the activity provider.** The seam is read-only.

## Configuration

All optional; the module loads and degrades with any of them absent.

| Key | Meaning |
| --- | --- |
| `timeZone` | Zone the plan week and weekly cron are evaluated in |
| `goalContext` | Free text: what the owner is training for |
| `activityHistoryProvider` | The composed activity-history seam |
| `activityWindowDays` | Trailing history window (default 42) |
| `weatherApiKey` / `weatherLocationKey` | Both present ⇒ a forecast; either absent ⇒ off |
| `weatherBaseUrl` / `weatherDays` | Provider base URL and horizon |
| `gwsAxiBin` / `calendarAccount` | Calendar read boundary |
| `plannerModel` | Pin a model, overriding the `synthesize` tier |
| `planCron` / `reconcileCron` | Schedules (defaults: Sun 07:00 local, every 10 min) |
| `staleAfter` | Coverage threshold (default `9 days`) |
| `disablePlanning` | Skip generation; reads + reconciliation still run |

## HTTP surface

```
GET  /api/training/plan              # the active plan covering a date, + that day's session
GET  /api/training/plans             # recent plans, any status
GET  /api/training/plans/:weekStart  # one week
POST /api/training/plan/generate     # regenerate now — still proposes, never activates
```

There is deliberately no endpoint that activates a plan directly. Approval lives
in the approvals module, and a second door into it would be a way around the
gate.
