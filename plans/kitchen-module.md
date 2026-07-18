---
status: done
depends: []
specs:
  - specs/modules/kitchen.md
issues: []
pr: 87
---

# Plan: Kitchen module (phase 1 — consumption journal)

## Scope

Implement phase 1 of `specs/modules/kitchen.md`: the `@jarvus/claude-assist-kitchen`
package (consumption entries, estimation, recipes), its `/api/kitchen/*` routes, the
estimation sweep worker, the meal-bank gitsheet read-through, the published
meal-record contract document, the kitchen daily-totals briefing source, and all
server/CI/Docker wiring for the new package.

**Out of scope** (phase 2, per the spec): inventory (receipts, labels, lexicon, stock
state, events), the `kitchen_event` capture-classifier type + ambient-remark resolver,
and the gitsheets consumer-verify contract check (the gitsheets contract-verify
surface hasn't shipped yet — this module reads the meal-bank sheet plain, with a
TODO left in `services/mealbank.ts` pointing at this spec section).

## Implements

- **specs/modules/kitchen.md § Data Requirements** — `kitchen.entries` +
  `kitchen.recipes` tables (migration `packages/kitchen/migrations/001-kitchen.sql`),
  ULID-keyed idempotent upserts, estimation status as the work queue
  (`estimating → estimated | failed`), photos held in memory only (never persisted,
  never written to disk).
- **§ Meal-bank sheet consumption** — `services/mealbank.ts` reads
  `KITCHEN_MEALBANK_REPO_PATH` / `KITCHEN_MEALBANK_SHEET` (both optional; unset
  degrades to recents-only reselect) via `gitsheets`' `openRepo`/`openSheet`, plain
  read (TODO left for the contract-verify flip).
- **§ API** — all eight `/api/kitchen/*` endpoints in `routes/kitchen.ts`: `POST
  /entries` (multipart), `GET /entries`, `GET /entries/:ulid`, `PATCH
  /entries/:ulid`, `DELETE /entries/:ulid`, `GET /reselect`, `POST /recipes`, `POST
  /entries/:ulid/promote`.
- **§ Estimation & model tiering** — `services/estimator.ts` (one vision call per
  attempt via `@anthropic-ai/sdk`, XML-tagged JSON parse + one retry — mirrors
  capture's classifier idiom rather than `output_config.format`, so the model tier
  stays swappable), configurable via `KITCHEN_ESTIMATION_MODEL` (default
  `claude-fable-5`), with a server-side note-derived portion modifier
  (`portionModifierFor`/`applyPortionModifier`).
- **§ Integration seams — Renderings** — `packages/briefing/src/briefing/sources/kitchen.ts`
  (today's calories/protein/sat-fat totals), wired into `compose.ts` / `runner.ts` /
  `render.ts`.
- **§ Principles** — `services/recipes.ts` (`computeRecipeMacros`, deterministic,
  never a model call) and the terminal-manual-override guard in
  `services/pipeline.ts`/`state.ts`.
- **Contract document** — `packages/kitchen/contracts/meal-record.v1.schema.json`.

## Approach

Mirrored `packages/capture/` structurally: `types.ts`, `state.ts` (transition FSM),
`store.ts` (interface + Pg impl) + `memory-store.ts`, `services/pipeline.ts`
(ingest/patch/promote/sweep), `routes/kitchen.ts`, `src/index.ts` (createPlugin +
scheduler registration). Two deliberate departures from the capture idiom, both
driven by the "photos never persisted" constraint in the spec:

1. **POST /entries attempts estimation synchronously**, using the in-memory photo
   buffers from that request — there is nowhere else they could be used, since they
   are discarded after every outcome. Capture's ingest is dumb-and-fast by design;
   kitchen's can't be, because the estimation input (the photo) only exists for the
   lifetime of the request.
2. **A replay POST (same ULID) while the row is still `estimating` re-attempts
   estimation** with whatever photos that replay carries, rather than being a pure
   ack-only idempotent no-op. This is the spec's own documented behavior ("The
   client retains its local copy... and re-posts to retry a stale `estimating`") —
   the client is the retry's source of truth, not a server-side sweep, because the
   server has nothing to retry with once the request ends.

The estimation source enum (`model | reselect | manual`) resolves an ambiguity in
the spec bullet "estimated when recipe-computed or reselect-cloned": both paths use
source `reselect` (deterministic, no model call) — recipe-computed is "reselect a
recipe, then supply quantities"; reselect-cloned is "reselect a past entry as-is."
Both are reached via the same reselect-strip UI action per the spec's `GET
/reselect` description.

`PATCH` semantics: presence of any nutrition field is a manual override (terminal,
`source: manual`, always accepted, sets label/note if given too). A note/label-only
edit re-queues estimation (`status → estimating`, immediate re-attempt, mirroring
capture's `correct()` — an explicit human action doesn't wait for the next sweep) —
refused with 409 when the entry is already `manual` (re-queuing would open the door
to a later model pass overwriting the owner's correction).

`promote` is a v1 simplification: it builds a single synthetic recipe component
from the entry's own resolved macros (treating the entry's portion as the 100g
reference — a ballpark, per the module's own "ballpark now beats precision later"
principle) rather than reconstructing the original recipe's real components when
the entry was itself recipe-computed. Richer reuse is a follow-up.

The `Estimator` interface (`services/estimator.ts`) is the pipeline's dependency,
not the concrete `KitchenEstimator` class — lets tests inject a scripted fake
without touching the Anthropic SDK.

`PluginOptions`/`createPlugin` in `packages/core` gained a `kitchenConfig` field
(mirrors every other module's plugin-options entry) — this is a shared-package
edit, reviewed alongside the module itself.

## Validation

- [x] `bun install` succeeds; `bun.lock` includes the new package + its new deps
      (`@fastify/multipart`, `gitsheets`, `p-limit`)
- [x] `bun run --filter @jarvus/claude-assist-core build` succeeds
- [x] `bun run --filter @jarvus/claude-assist-kitchen build` succeeds
- [x] `bun run --filter @jarvus/claude-assist-briefing build` succeeds (kitchen source wiring)
- [x] `bun run --filter @jarvus/claude-assist-server build` succeeds (registers the plugin)
- [x] `bun run build` (all packages) succeeds
- [x] `bun test` is green across the whole repo (1208 pass / 0 fail at closeout,
      including 60 new kitchen tests and updated briefing tests)
- [x] `bun run type-check:axi` unaffected (kitchen has no axi CLI)
- [x] `bun run check:skills` unaffected
- [x] `bun install --frozen-lockfile` succeeds (matches the CI install step)
- [ ] Docker image builds (`docker build -f apps/server/Dockerfile .`) — **could not
      verify locally, no Docker daemon available in the build environment.** CI's
      `docker` job will be the first real gate; `.dockerignore` and `Dockerfile`
      were edited by hand following the existing per-package pattern exactly.
- [ ] A live server + real `ANTHROPIC_API_KEY` produces a plausible estimate from an
      actual meal photo — **not verified locally** (no live server / phone in this
      environment). Verified instead via a scripted fake `Estimator` in tests.
- [ ] A real meal-bank gitsheet read (`KITCHEN_MEALBANK_REPO_PATH` +
      `KITCHEN_MEALBANK_SHEET` pointed at an actual `.gitsheets/` sheet) round-trips
      into recipes — **not verified locally**; `readMealBankRecipes` is only tested
      against the "config unset" and "repo doesn't exist" degrade-gracefully paths.

## Risks / unknowns

- **Estimation quality on a retried sweep with no photos.** Once a synchronous
  attempt fails (rate limit, etc.) and the row falls to the sweep, subsequent
  retries use note text only — no photos survive to a sweep pass. This is an
  accepted, documented degradation (see Approach), not a bug, but it means a
  photo-only entry with no note that fails its one synchronous attempt will sit in
  `estimating` until the owner either re-POSTs (replay) or supplies a manual
  correction.
- **Meal-bank sheet record shape** is inferred from the published contract
  (`contracts/meal-record.v1.schema.json`), not validated against a real sheet —
  the read degrades to an empty list on any parse failure per-record, so a
  malformed sheet never crashes the reselect strip, but the mapping itself is
  unverified against live data.
- **`gitsheets` contract-verify surface** doesn't exist yet; the TODO in
  `services/mealbank.ts` is the tracked spot to flip on `contract: { schema, mode:
  'verify' }` once it ships.

## Notes

- `EstimationSource` has exactly three values per the spec
  (`model | reselect | manual`); the ambiguity between "recipe-computed" and
  "reselect-cloned" (both mentioned in the `POST /entries` spec bullet) resolved to
  both using `reselect` — see Approach for the reasoning. If a future spec revision
  wants to distinguish them, that's a spec change + a migration, not a silent code
  drift.
- `NUTRITION_FIELD_KEYS` is defined `as const satisfies readonly (keyof
  NutritionFields)[]` rather than typed directly as `(keyof NutritionFields)[]` —
  the wider `keyof` type let `confidence`/`portion_basis` leak into the PATCH
  macro-override key iteration, which doesn't type-check against `EntryPatchInput`
  (which only exposes `portion_basis`, not `confidence`, as a settable field).
- `packages/core/src/plugin.ts` and `src/index.ts` picked up a new
  `KitchenPluginConfig` export alongside every other module's plugin-options entry
  — a small, mechanical shared-package diff, not a design change.

## Follow-ups

- Issue — richer `promote`: reuse the original recipe's real components when the
  promoted entry was itself recipe-computed, instead of always synthesizing a
  single component from the entry's flattened macros.
- Issue — flip `services/mealbank.ts`'s gitsheets read to `contract: { schema:
  MEAL_RECORD_CONTRACT, mode: 'verify' }` once the gitsheets consumer-verify
  surface ships (tracked inline via the TODO comment; no issue filed yet since the
  upstream feature isn't scheduled).
- Deferred to phase 2 (per specs/modules/kitchen.md, not yet a plan file):
  inventory (receipts, labels, lexicon, stock state, events) and the
  `kitchen_event` capture-classifier integration.
