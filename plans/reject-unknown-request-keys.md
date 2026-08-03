---
status: in-progress
depends: [kitchen-module, product-corrections]
specs:
  - specs/modules/kitchen.md
---

# Plan: reject unknown request keys instead of silently stripping them

## Why

Production, same day: `PATCH /kitchen/products/:ulid` with a body that misnamed
the panel field (`nutrition` instead of `nutrition_per_100g`) alongside two
correctly-named fields returned `200`, applied the two correct fields, and
discarded the panel with no trace. The product was left with
`nutrition_per_100g: null` while the caller believed a full panel had landed. It
surfaced only because an inventory item stayed flagged `needs_nutrition` and
someone asked why — the exact failure class `kitchen-plausible-wrong-numbers`
already designs against (a wrong record that nothing downstream flags), just
shaped as a dropped field instead of a wrong number.

The route schema already declares `additionalProperties: false` and already
lists `nutrition_per_100g` as the real key — this was not a permissive-schema
bug. The actual cause is one level down: Fastify's default AJV compiler
(`@fastify/ajv-compiler`) sets `removeAdditional: true`, and that combination is
documented upstream AJV behavior for a different purpose than the schema
author intended — SILENTLY STRIP a key `additionalProperties: false` doesn't
recognize, rather than fail validation on it. Every write schema in the kitchen
module has this shape, so every one of them has been silently stripping
misnamed/unknown keys since day one, not just the products PATCH that happened
to get reported.

## Scope

**In scope**: every schema-validated write body (and named-querystring GET) in
`packages/kitchen/src/routes/{kitchen,inventory,expenditures,weigh-ins}.ts` —
the four files register routes under `/api/kitchen` directly onto their own
Fastify sub-instance, so a validator-compiler override installed at the top of
each one covers every route declared in that file, GET querystrings included.

**Out of scope**:

- `POST /kitchen/entries`, `POST /kitchen/entries/:ulid/promote`,
  `POST /kitchen/receipts`, `POST /kitchen/inventory/:ulid/label` — multipart
  or hand-parsed bodies with no AJV `schema.body` at all; unaffected by
  `removeAdditional` because AJV never runs on them, and their manual
  validation already refuses stray fields (see the existing "rejects an
  unknown key inside macros" coverage in `kitchen.test.ts`).
- `POST /kitchen/plan-session` — ignores its body entirely (no fields to lose).
- **Every OTHER module's routes** (`google`, `sessions`, `capture`, `notify`,
  `chat`, `pages`, `ledger`, `briefing`, `slack-urgency`, `session-spawn`).
  They share the exact same root cause — `apps/server/src/server.ts` never
  overrides Fastify's default AJV options, so any module whose schema declares
  `additionalProperties: false` has the identical silent-strip defect — but
  fixing them is not this plan's mandate; it fixes the module that regressed
  in production. **Flagged as a follow-up below**, not fixed here.

## Implements

- `specs/modules/kitchen.md` § Request validation is strict, not permissive
  (new section, added by this plan) — every write schema rejects an
  unrecognized key with a `400` naming the key, and a near-miss suggestion
  when one is unambiguous.

## Approach

1. **`packages/kitchen/src/strict-validation.ts` (new)** — `installStrictValidation(fastify)`:
   - A module-local `Ajv` instance (`removeAdditional: false`, everything else
     mirroring `@fastify/ajv-compiler`'s own defaults — `coerceTypes: 'array'`,
     `useDefaults: true`, `allErrors: true`, plus `ajv-formats` registered so
     `format: 'date-time'` schemas keep working) — `removeAdditional: false` is
     the one deliberate change: it's what makes `additionalProperties: false`
     actually reject instead of silently filtering.
   - `fastify.setValidatorCompiler(...)` swaps it in for the calling
     encapsulated instance (and everything registered on it afterward).
   - `fastify.setErrorHandler(...)` intercepts `FST_ERR_VALIDATION` errors,
     and for any `additionalProperties` violation, builds a message naming the
     offending key(s). A near-miss suggestion is offered when the schema has an
     unambiguous better answer: a prefix relationship first (`nutrition` →
     `nutrition_per_100g`), narrowed by the offending value's own JSON type and
     — for an object value — how many of its keys overlap a candidate's nested
     `properties` (disambiguates when two prefix matches both fit
     structurally); ties are reported together rather than guessing one.
     Non-`additionalProperties` validation errors (type/enum/etc., which were
     never silently dropped — only unmatched keys were) fall through to
     Fastify's normal handling via `reply.send(err)`.
2. **Wire it in** — `installStrictValidation(fastify)` as the first statement
   in each of `registerKitchenRoutes`, `registerInventoryRoutes`,
   `registerExpenditureRoutes`, `registerWeighInRoutes`. Placed in the
   route-registration function itself (not the module's top-level
   `src/index.ts` plugin) so the guarantee holds regardless of how the file is
   mounted — including the test suite, which registers these functions
   directly onto a bare `Fastify()` instance, bypassing the top-level plugin
   entirely.
3. **Dependency** — `ajv` (pinned `8.17.1`, matching the version already
   resolved transitively via `@fastify/ajv-compiler` so bun's isolated linker
   shares one copy instead of two structurally-incompatible ones) and
   `ajv-formats` added as direct `packages/kitchen` dependencies.
4. **Spec** — `specs/modules/kitchen.md` gains
   § Request validation is strict, not permissive under `## API`, stating the
   rule and naming the `removeAdditional`/`additionalProperties` interaction
   explicitly so the next module doesn't rediscover it by production incident.

## Validation

- [x] `PATCH /kitchen/products/:ulid` with the exact reported shape
      (`nutrition` + `nutrition_source` + `unit_edible_g`) now `400`s, names
      `"nutrition"`, and suggests `nutrition_per_100g`/`nutrition_per_serving`
      — `inventory.test.ts` "PATCH refuses an unrecognized key instead of
      silently dropping it (the reported defect)", including an assertion
      that NONE of the request's fields applied (not even the correctly-named
      ones) and that the correctly-named field still works afterward.
- [x] `POST /kitchen/products` has the same regression coverage.
- [x] At least one regression test added per other affected route file
      (`kitchen.test.ts` PATCH /entries, `expenditures.test.ts` POST
      /expenditures, `weigh-ins.test.ts` POST /weigh-ins) proving the fix is
      module-wide, not products-only.
- [x] Every internal caller (kitchen-axi CLI commands, checked against each
      endpoint's schema field-for-field) sends only recognized keys —
      tightening validation breaks nothing today.
- [x] `bun run test`, `bun run build`, `bun run type-check:axi`,
      `bun run check:skills` all green, from the repo root.
- [ ] Live-traffic confirmation that no external caller outside this repo
      (the capture app referenced in `weigh-ins.ts`'s `hc_uuid` comment,
      or any other out-of-repo client) sends an extra key — not verifiable
      from this checkout; flagged in the PR for Chris to confirm before merge.

## Risks / unknowns

- **Scope was wider than the ticket implied.** The task framed this as "is it
  just PATCH /products, or other kitchen write endpoints" — the actual answer
  is "every kitchen write endpoint with a schema, via one shared root cause,"
  and the root cause itself extends past the kitchen module to every other
  module in the server. Fixed only in kitchen per this plan's mandate; the
  repo-wide extent is a follow-up, not a surprise discovered after merge.
- **Near-miss suggestion quality.** The heuristic (prefix match, narrowed by
  runtime-type and object-key overlap, ties reported together) is deliberately
  conservative — it can offer multiple candidates or none, but should never
  offer a confidently wrong one. Worth a second look if a future misnamed-key
  incident gets a useless suggestion.

## Follow-ups

- Issue — apply the same `installStrictValidation` pattern (or a shared
  version promoted to `packages/core`) to every other module
  (`google`, `sessions`, `capture`, `notify`, `chat`, `pages`, `ledger`,
  `briefing`, `slack-urgency`, `session-spawn`). Each shares the identical
  `removeAdditional: true` default and has never been audited for this. Not
  filed as a numbered issue yet — flagged here for Chris to triage; this
  plan's mandate was the module that regressed, not a repo-wide sweep.
