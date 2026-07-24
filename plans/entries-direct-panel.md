---
status: done
depends: [kitchen-module]
specs:
  - specs/modules/kitchen.md
issues: []
pr: 140
---

# Plan: Directly-stated panel entries (born-manual `POST /entries`)

## Scope

Add a fourth creation shape to `POST /entries`: a `macros` panel object that is
stored verbatim as a born-`manual`, terminal (`estimated`) entry which **enqueues
no estimation**. This closes the gap where a client that has already computed an
entry's full eight-field panel has no way to record it in one step — today it must
`POST` (triggering a model estimate) then `PATCH` an override, a sequence that is
racy by construction (the original estimation job can land after the override and
clobber it). Implements the § Directly-stated panel entries section of
`specs/modules/kitchen.md`.

**Out of scope:**

- The recipe model's direction (explicitly orthogonal — see the spec's closing
  note; this primitive neither depends on nor constrains it).
- Client adoption. Callers that currently compute a panel and then log-with-inputs
  (e.g. interactive prep/portion-builder surfaces, the `kitchen-axi` CLI) migrate
  to the new shape separately; this plan ships the endpoint + the CLI flag to
  exercise it, not a sweep of every consumer.
- Any change to the model estimator, recipe compute (`computeRecipeMacros`), or
  reselect cloning.

## Implements

- `specs/modules/kitchen.md` § Directly-stated panel entries — the `macros`
  creation shape, its mutual exclusivity, born-`manual`/terminal semantics, and
  the no-estimation-enqueued invariant.
- `specs/modules/kitchen.md` § Nutrition panel — the new "Directly-stated panel"
  source bullet.
- `specs/modules/kitchen.md` § API `POST /entries` — the amended contract line.
- The § Principles (local) rule "A caller that knows the answer states it; the
  system never re-guesses it."

## Approach

- **Request validation**: accept a `macros` object on the entry JSON part.
  Reject (`400`) when combined with `recipe_ulid`, `reselect_of`, component
  quantities, or photo parts. Validate each of the eight fields is a number or
  absent (absent → `null`, never coerced to `0`); reject unknown keys.
- **Persistence**: write the panel straight to the base macro columns,
  `source = 'manual'`, `status = 'estimated'`, `portion_multiplier = 1` default.
  No row enters the `estimating` work queue — the estimation dispatch path is
  never touched for these posts.
- **Idempotency**: same ULID-keyed idempotency as the other creation shapes; a
  replayed born-manual POST is a safe no-op, not a duplicate or a re-write.
- **CLI surface** (`kitchen-axi`): a way to log a known panel directly (e.g.
  `entries log --macros '<json>'` or explicit `--calories/--protein/...` at
  `log` time) so the shape is exercised end-to-end and the log→estimate→patch
  dance is retired for callers that already hold the numbers.

## Validation

- [x] `POST /entries` with a `macros` panel returns a `source: 'manual'`,
      `status: 'estimated'` entry whose base fields equal the input verbatim.
- [x] No estimation job is enqueued for a `macros` POST (assert the work queue /
      dispatch is untouched; the entry never passes through `estimating`).
- [x] Unstated panel fields persist as `null`, not `0`.
- [x] `macros` combined with `recipe_ulid`, `reselect_of`, component quantities,
      or a photo part each `400`.
- [x] Idempotent on ULID: replaying the same born-manual POST neither duplicates
      nor mutates the entry.
- [x] A subsequent `PATCH` note/label edit on the born-manual entry does **not**
      re-queue estimation; `portion_multiplier` scales the stated base normally.
- [x] Regression: the log→estimate→patch race is gone — a client computing a
      panel and posting it directly yields the exact stated totals with no
      window in which a model estimate can overwrite them.
- [x] `kitchen-axi` can create a directly-stated entry in one command and the
      resulting entry matches the supplied panel.

## Decisions (during build)

- **Wire shape**: nested `{"macros": {...}}` object (as leaned in Risks), which
  localizes the mutual-exclusion and unknown-key checks to one validator.
- **CLI ergonomics**: **per-field flags at `log`** (`--calories/--protein/--fat/
  --sat-fat/--carbs/--sugar/--fiber/--sodium`), mirroring `entries patch`'s macro
  flags exactly — any present macro flag makes the log a directly-stated panel.
  Chosen over `--macros '<json>'` for symmetry with `patch` (the task's stated
  ergonomic target). An optional `--label` names the born-manual entry.
- **`label` at creation** (spec: "note/label may accompany"): added an optional
  `label` to the `macros` shape for provenance/display. Honored **only** with
  `macros` — a `label` (or `--label`) sent without a panel is a `400`/CLI error
  rather than silently dropped (the other shapes derive label from their source).
- **Field domain** (spec ambiguity: "a number or absent"): each panel field must
  be a **non-negative finite number or absent**; explicit `null` and negatives
  are rejected (absent is the sole "unknown" encoding, stored as `null`). This
  matches the `patch` macro-override bound (`minimum: 0`) and keeps the
  absent→null rule crisp.

## Risks / unknowns

- **Wire shape of `macros`**: nested object vs. flat fields on the entry JSON
  part. Lean nested (`{"macros": {...}}`) to keep the mutual-exclusion check and
  the "unknown keys rejected" validation localized. Settle at implementation.
- **CLI ergonomics**: whether to expose `--macros <json>` or per-field flags at
  `log` time. Per-field mirrors `patch`; JSON mirrors how a page would post.
  Minor, decide during build.

## Notes

- Shipped the `macros` creation shape in `packages/kitchen/src`: request
  validation + mutual-exclusion in `routes/kitchen.ts`, the born-manual
  deterministic write in `services/pipeline.ts` (mirrors the recipe/reselect
  branches — one atomic `applyEstimate` to terminal `estimated`/`source:manual`,
  and crucially **no `attemptEstimate` call**, so nothing enters the estimation
  work queue), panel/`label` types in `types.ts`, and per-field `entries log`
  flags in the `kitchen-axi` CLI.
- **CLI shape**: per-field flags at `log` time (`--calories/--protein/…`),
  mirroring `entries patch`'s macro flags, plus optional `--label`. Chosen over
  a `--macros <json>` blob for consistency with the existing patch ergonomics.
- **Spec ambiguities resolved during build**: (1) "a number or absent" ⇒ each
  field must be a non-negative finite number or absent; explicit `null` and
  negatives `400`, absent is the sole "unknown" encoding (stored `null`),
  matching `patch`'s `minimum:0` bound. (2) A `label` sent without a `macros`
  panel is a `400` rather than silently dropped (other shapes derive label from
  their source).
- Verified independently before merge: `bun test packages/kitchen/src` → 280
  pass / 0 fail (24 new, including a regression test that no model estimate can
  clobber a stated panel); `bun run build` green; CI on PR #140 green (Build &
  Test, Docker Build); full-diff scrub scan clean.

## Follow-ups

- **Deferred to client adoption** (not a plan yet): migrate callers that today
  compute a panel then log-with-inputs — interactive prep/portion-builder
  surfaces and any `kitchen-axi` prep-page flow — onto the born-manual shape so
  the log→estimate→patch dance is fully retired. Out of scope here by design;
  this plan shipped the endpoint + CLI that make the migration possible.
