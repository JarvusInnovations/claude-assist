---
status: in-progress
depends: []
specs:
  - specs/modules/session-spawn.md
  - specs/modules/kitchen.md
issues: []
pr:
---

# Plan: Session-spawn module + kitchen plan-session endpoint

## Scope

Implement the generic session-spawn surface (`specs/modules/session-spawn.md`)
and its first configured caller, the kitchen plan-session endpoint
(`specs/modules/kitchen.md` § Plan-session): the "spawn a warm interactive
session and ping the phone with a takeover link" half of the app-initiated
gather-and-ping flow.

In scope: the `@jarvus/claude-assist-session-spawn` package (a stateless
command-runner + dispatcher), the `SessionSpawner` core contract, the
`POST /api/kitchen/plan-session` route + planning-context builder + preload
prompt, and all server/env wiring.

**Out of scope**: the app button (a separate surface consumes this endpoint's
wire contract) and whatever the instance configures `SESSION_SPAWN_CMD` to point
at — the toolkit knows only "a command that returns a takeover link."

## Implements

- **specs/modules/session-spawn.md** — the `SessionSpawner` service: runs the
  configured `SESSION_SPAWN_CMD` (JSON argv) with the preload prompt written to a
  temp file appended as the final argv element, extracts the first `https://`
  URL from stdout as the takeover link, dispatches it through the existing
  notify dispatcher (redacted at rest), and returns a link-free spawn record.
  Disabled (503 at the route) when unconfigured; fail-loud on non-zero exit /
  timeout / no-URL.
- **specs/modules/kitchen.md § Plan-session** — `POST /api/kitchen/plan-session`:
  gathers today's effective totals, eat-first inventory, recent meals,
  meal-bank/reselect options, and open needs-info items; composes a warm-start
  preload prompt; calls the shared spawner; returns an ack (`{status, spawn_id}`),
  never the link.

## Approach

- `SessionSpawner` interface + `SpawnRequest`/`SpawnRecord` types live in `core`
  (like the notify contracts) so any module calls `fastify.sessionSpawner`
  type-safely. The new package decorates it; the kitchen route reads it at
  request time and 503s when absent/unconfigured.
- Delivery reuses the notify dispatcher + its RC-link redaction — the module
  grows no delivery code. The takeover link travels only in the delivered push;
  the spawner never logs stdout and passes any stderr reason through redaction.
- The context builder reads the kitchen module's own stores (no cross-module
  import), computing effective totals the same way the briefing daily-totals
  source does (`base × portion_multiplier` over today's estimated entries).

## Validation

- [x] Generic spawner runs a configured command, dispatches the takeover link,
      and returns a record with no link (unit tests with a fake spawn fixture).
- [x] Security: the raw link is absent from the returned record and from all
      captured logs, present only in the dispatched push (asserted explicitly).
- [x] Non-zero exit / timeout / no-URL all fail loud with a failure push, never
      hang.
- [x] Unconfigured (`SESSION_SPAWN_CMD` unset) ⇒ `not_configured` record ⇒ route
      503.
- [x] `POST /api/kitchen/plan-session`: happy path 200 ack (link absent from the
      response); unconfigured 503; spawn failure 502 + failure push.
- [x] Context builder reflects effective totals (portion-multiplier-aware) and
      eat-first ordering.
- [x] Full `bun install` / `bun run build` / aggregate suite green; `check:skills`
      clean (no axi surface change).

## Risks / unknowns

- **Spawn latency / link-scrape fragility** — bounded by the spawner timeout; a
  slow or hung command becomes a failure push, never a hang.
- **Notify dependency** — the link rides the push alone, so the feature requires
  the notify module; without it the decorator is absent and the route 503s.

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
