# Module: Finance

A **monthly** reconciliation of a personal transaction ledger: pull the closed
month from a provider, mirror it locally, compose a review, publish it as a
page, link it from a notes system, ping once, and beat a coverage heartbeat.
Alongside it, a categorize/annotate **assist** that proposes and never edits.

The module is instance-agnostic: it knows nothing about which provider, which
accounts, or whose money. Credentials, the provider's base URL, the timezone,
and the currency are all instance config with no defaults where a wrong default
would be worse than an absent one.

## Two rules that outrank every feature

**1. Monthly batch, no daily ritual.** The module registers exactly one
schedule. There is no daily sweep, no morning finance section, no
spending-so-far-today. A daily finance chore gets skipped, and a skipped daily
chore trains its owner to ignore the whole surface. The cadence is the design.

**2. Assist, never autonomous ledger edits.** The model proposes; a human
decides; applying is a third, separate act. `finance.suggestions` is a table of
*proposals*. Deciding one records a decision and touches nothing external.
Applying is a distinct HTTP verb that acts only on `accepted` rows. No scheduled
task can reach the apply path, and the monthly runner does not import it.

## Personal-domain boundary

This module holds the owner's own financial credentials. It writes to exactly
two places: its own schema, and — only from an explicit human-initiated apply —
the owner's own ledger at the provider. It has **no** write path to any shared
or team system of record and must not grow one. Notifications reach the owner's
own device; the review is served behind the same private surface as every other
page the host serves.

## Sources

A source satisfies one interface (`preflight`, `listTransactions`,
`listAccounts`, `listCategories`, `updateTransaction`). Which implementation is
in play is config, not a code path that leaks into the domain.

- **`api`** — the provider's own HTTP API, spoken directly. These APIs are
  generally unofficial and undocumented, so: every GraphQL document lives in one
  file, responses are read through accessors that raise `schema_drift` rather
  than returning an empty list, and the batch **probes before it pulls**.
- **`command`** — an operator-supplied exporter, spoken to over stdin/stdout
  with a documented JSON envelope. The seam for a headless browser session on a
  machine that stays logged in. Driving that browser is deliberately *not* this
  module's job: it is provider-specific and fragile, and belongs where the
  operator can watch it fail. The contract is in the package RUNBOOK.

A source reports unavailability with a reason: `not_configured`,
`unauthenticated`, `unavailable`, `schema_drift`. The distinction is
load-bearing — a logged-out browser session needs a human at a console, a broken
exporter needs a bug fix, and drift needs a document edit.

## Data model

Schema `finance`, migration `001-finance.sql`:

- **`finance.transactions`** — the local mirror, upserted by each pull, keyed by
  the provider's id. Amounts are stored in the **provider's** sign convention,
  verbatim; normalizing at ingest would bake one provider's choice into the
  schema. The mirror exists so a review is reproducible and so a provider outage
  degrades to "stale" rather than "no review".
- **`finance.accounts`** — balances at pull time, for context.
- **`finance.reviews`** — one row per period, `period_key` (`YYYY-MM`) unique, so
  the batch's natural idempotency key is a database constraint. Status is one of
  `pending | running | rendered | failed | blocked`. Carries where the review
  landed (page slug/URL, notes-system node id, notified-at) and the composed
  `summary` JSONB, so the page can be re-rendered without re-pulling. Lease
  columns per `behaviors/scheduled-work-leases.md`.
- **`finance.suggestions`** — the assist's proposals, unique per
  `(review, transaction, kind)`. `applied_at` is the only column whose being set
  means an external ledger was touched.
- **`finance.provider_session`** — single-row session token, so a monthly pull
  does not re-trip MFA.

## The monthly batch

`preflight → pull → compose → assist → publish → link → ping → beat`.

**Preflight-and-exit-clean.** An unusable source produces one `blocked` review
carrying the reason, no notification, and **no heartbeat**. What it must never
produce is a confident, empty review: a month that reports no spending because a
schema moved is worse than no month at all.

**Composition is deterministic.** Totals, month-over-month deltas, and the
flagging rules are pure functions of the mirrored rows. A model's opinion
arrives afterward, attached to an already-flagged row, and never decides which
rows appear. A reconciliation whose contents depend on a model's mood is not a
reconciliation.

Four flags, in the order a human wants them: the source's own review flag; a
large outflow; a merchant with no prior-month appearance (claimed only when
there *is* a prior month to have seen it in); a row still pending after the
period closed.

**Every surface after the pull degrades independently.** No page, no notes
system, or no dispatcher each subtract one thing from the outcome. None of them
sinks the review or loses the pulled data, which is already mirrored by then.

**The heartbeat is earned.** `beat()` fires only on a run that rendered
something. Blocked and failed runs leave the heartbeat where it was.

## Coverage

The pipeline registers `finance-review` with the coverage ledger **at plugin
load**, before any successful run — an instance that has never produced a review
is itself the fact worth alerting on. The default threshold is a month plus
slack, so a batch that runs a few days late is quiet and a skipped month pages.

## Assist

Candidates are the rows the deterministic composer already flagged,
uncategorized first, deduplicated and capped. The model picks a category **from
the ledger's own category list** — a free-text category would be a proposal the
apply path could not honor, which is worse than no proposal — and may add one
short annotation. Proposals that restate the current value are dropped:
proposing what is already true teaches the reader to stop reading.

The assist never fails the batch. No key, a spend ceiling, a bad response — the
review renders with its flagged rows and no proposals.

## Surfaces

`GET /api/finance/source` (is the source reachable), `GET /api/finance/reviews`,
`GET /api/finance/reviews/:period`, `POST /api/finance/reviews/run`,
`POST /api/finance/reviews/:id/suggestions/:sid/decide`, and
`POST /api/finance/reviews/:id/apply`.

The rendered page carries Accept/Reject controls that post to the decide route.
This is what makes one-tap accept safe: the tap records a decision, and the page
says so in as many words. Applying stays a separate, deliberate act.
