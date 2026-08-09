---
status: done
depends: [approvals, model-invoker]
specs:
  - specs/modules/training.md
  - specs/modules/briefing.md
---

# Plan: Weekly adaptive training loop

## Scope

A new `training` module: generate a weekly training plan from activity history +
forecast + calendar availability, propose it for asynchronous approval, and
render the approved day's session into the daily briefing. In scope: the weekly
generation, the approval gate and its reconciliation, the briefing section, and
the coverage registration. Out of scope: the briefing frame itself (this slots
content into the established contract), energy expenditure (the kitchen module's
expenditure ledger owns it), and any recovery telemetry that isn't reachable
through the activity-history seam.

## Implements

- `specs/modules/training.md` — the whole module.
- `specs/modules/briefing.md` — a new content-contract section, degrading to
  absence exactly like the others.

## Approach

- **New package `packages/training`.** Schema `training`, one table
  (`week_plans`), two partial unique indexes holding "at most one active and at
  most one proposed plan per week".
- **Three input sources, each degrading to a flagged error.** Activity history
  arrives through a new provider-agnostic seam in core
  (`ActivityHistoryProvider`) composed by the host from the module that owns the
  upstream OAuth credentials — one refresh-token rotator per instance, however
  many consumers. Calendar availability reuses the briefing module's exported
  `gws-axi` read rather than duplicating the shell-out and its TOON parse; the
  dependency runs one way, since the briefing's training source reads
  `training.week_plans` over SQL rather than importing back.
- **One metered call**, `synthesize` tier, through the invoker, answering a
  tagged JSON payload validated against the week it was asked for. No
  deterministic fallback: without a credential the job preflights and exits
  clean.
- **Escalation-as-abort.** Generation stores `proposed`, raises one deduped
  approval at `notice` priority, and returns. A short-cadence reconciliation
  pass settles approved / denied / expired.
- **Coverage.** Pipeline `training-plan`, registered up-front, weekly-plus-slack
  threshold, beaten only on a run that produced or found a week.

## Validation

- [x] A weekly job generates a plan from activity history + forecast + calendar.
- [x] The day's training renders into the daily briefing's training section, and
      the section is absent — not "unavailable" — when no week is active.
- [x] Adjustment proposals are delivered for async approval; no code path awaits
      a human, and an unanswered gate expires the plan closed.
- [x] The pipeline registers a coverage ledger with a weekly staleness threshold.
- [x] Every credentialed input preflights and exits clean when its config is
      absent, rather than failing the run.

## Risks / unknowns

- **Input availability** — all three sources degrade independently, and the
  degraded list is named in the approval body so a human knows what the week was
  planned without.
- **Plan quality vs. autonomy** — adjustments are proposed, never imposed. Only
  an `active` week renders; there is no HTTP route that activates one.
- **Two rotators for one OAuth app** — the failure mode the activity-history
  seam exists to prevent. Any future consumer of activity history takes the
  seam; it does not get its own refresh token.

## Notes

- Fixed in passing: `createPlugin` was dropping `invokerConfig` and
  `approvalsConfig` from the options it forwards to a plugin's setup, so the
  invoker never saw `ANTHROPIC_API_KEY` and reported `enabled: false` — silently
  degrading every model-backed feature in the host. Both are now forwarded.
- The kitchen module's Strava client is now constructed whenever its credentials
  exist, independent of whether the expenditure *sync* is enabled: the
  read-only activity-history seam is a different consumer with a different kill
  switch, and disabling the calorie sync should not also blind it.

## Follow-ups

- The synthesis has never been exercised against a live model or live provider
  credentials; the runbook in the PR body covers first-boot verification.
- Recovery telemetry (body battery, stress, HRV-class signals) stays a periodic
  agent-side protocol by explicit decision, and must not become an automated
  dependency of this loop.
