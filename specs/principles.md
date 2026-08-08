# Principles

Decisive trade-offs this codebase has already resolved. Each picks a side, so an
implementer — human or agent — settles an unspecified case the way the project
would. When a new decision recurs three times, it belongs here.

## The toolkit is generic; the instance is private

This repo is public and carries no owner. No personal name, assistant name,
hostname, private-system name, roster, rule set, contact, calendar, or schedule
appears in any git surface — code, comments, specs, plans, commit messages, PR
bodies, or history. Instance-shaped content is exposed as a **pluggable
interface plus a config path**: the toolkit ships the mechanism and an
`EXAMPLE_`-prefixed sample, the instance supplies the content at a path an env
var names. When a feature seems to need instance knowledge, that is the signal to
find the seam, not to commit the knowledge.

## Single invoker, honest billing

Every metered model call routes through one hardened module, so a provider
policy, billing, or format change is a one-module adaptation. Background work
runs on metered API credentials and is engineered cheap; a human-driven
interactive session runs on that human's own credentials and never on the
service's. No credential rotation, no puppeting an interactive client to dodge
metering — borrowed time is not a foundation.

## Gather cheap, judge expensive

Mechanical gathering and classification run on the cheapest adequate model;
synthesis and drafting run on a strong model once per batch. A caller names the
**job**, not the model, so the mapping can move without touching call sites.
Before spending a token, spend a deterministic pre-pass: the classifier that only
sees the residue a keyword filter couldn't decide is the cheapest classifier.

## Never block on a human

Work that needs a person records the request, dispatches a notification, and
returns. No handler, worker, or scheduled task ever holds a lease, a connection,
or a concurrency slot waiting for an answer. Resolution arrives later as its own
event. A request that is never answered expires rather than hanging.

## The database is the coordination primitive

Concurrency safety comes from Postgres — advisory locks, `FOR UPDATE … SKIP
LOCKED`, lease expiry, unique indexes — not from process-local flags. A
process-local guard is invisible to a second process and does not survive a
restart, which means it protects exactly the case that was never the risk. If a
guard cannot be expressed in the database, the design needs revisiting.

## Alert on the absence of success

A pipeline that can fall behind silently will. Every ingestion or sync pipeline
declares a coverage heartbeat and a staleness threshold, and staleness itself
notifies. Errors are the easy case; the expensive outage is the one where
nothing threw.

## Interrupts are earned

The push channel only works if silence is trustworthy. An `interrupt` fires for
what genuinely cannot wait; everything else batches into a digest. The test for
a new alert: would the owner regret seeing this an hour later? If not, it is
digest material.

## Degrade, don't fail

An optional capability whose credential or config is absent turns itself off and
says so at boot. It does not throw at first use, and it does not take the host
down. Every model-backed feature has a deterministic fallback or an honest
"unavailable" — a feature that can only work with a model is a feature that
breaks the whole instance when the key expires.

## Contracts in core, implementations in packages

When one module needs what another provides, the interface goes in `core` and the
implementation stays in its own package. Modules depend on core, never on each
other. The payoff is testability: a narrow interface is a seam a stub can fill,
and every model-backed service in this repo is tested without a model because of
it.

## A response code is a claim

A handler never answers `200` for work it did not do. Failing loudly at a wrong
path costs one confused caller; succeeding falsely costs a write that never
happened and that nobody notices until a ledger disagrees days later.
