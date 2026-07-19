---
status: done
depends: [kitchen-module]
specs:
  - specs/modules/kitchen.md
issues: []
pr: 104
---

# Plan: Meal-bank contract-verified read

## Scope

Flip `packages/kitchen/src/services/mealbank.ts` from a plain gitsheet read to
the gitsheets 2.5.0 **contracts consumer-verify** surface, closing the deferral
recorded in [`kitchen-module`](kitchen-module.md) Follow-ups ("flip … to
`contract: { schema, mode: 'verify' }` once the gitsheets consumer-verify
surface ships" — tracked inline via the TODO in `mealbank.ts`; upstream has now
shipped). Also: bump the kitchen package's `gitsheets` dependency to `^2.5.0`,
and update `specs/modules/kitchen.md` § Meal-bank sheet consumption to state
the verified read and its degradation story.

**Out of scope**: any producer-side adoption (vendoring the contract into an
instance's meal-bank repo is instance configuration, not toolkit work), and any
new API/axi surface.

## Implements

- **specs/modules/kitchen.md § Meal-bank sheet consumption** — the read opens
  with `contract: { schema: <meal-record.v1.schema.json>, mode: 'verify' }`;
  rung-1 declared identity preferred, structural fallback; wiring-time refusal
  on non-conformance with degradation to recents-only reselect.

## Approach

- `readMealBankRecipes` loads the packaged contract document
  (`contracts/meal-record.v1.schema.json`, resolved relative to the module so
  src and dist both work) and passes it as a parsed object — no `format` key
  needed (that's only for string input).
- `mode: 'verify'` is the shipped default, but is passed explicitly since the
  spec names it. After open, `sheet.contractVerification.rung === 'structural'`
  triggers an info log noting undeclared conformance (nudging producers toward
  `gitsheets contracts adopt`); rung `declared` reads silently.
- `ContractError` (any code) in the catch path gets its own warn log
  ("refused at wiring time … degrading to recents-only reselect"); all other
  errors keep the existing degrade log. Either way the function returns `[]`
  and never throws — same contract as the missing-config path, so the server
  and reselect behave exactly as before on a bad sheet.
- `onDrift` is wired to an advisory warn log (structural-verified sheets only,
  per the shipped API — reads are never blocked post-wiring).
- Tests build three real fixture gitsheet repos (generic content, e.g.
  "Example bowl") in a temp dir via `git` + the `gitsheets` CLI:
  declared-conforming (CLI `contracts adopt` + `implements` in the sheet
  config), undeclared-conforming, and non-conforming (record missing `name`,
  string `calories`).

## Validation

- [x] `bun add gitsheets@^2.5.0` in `packages/kitchen` (lockfile rides the
      same commit)
- [x] Declared-conforming fixture verifies rung-1 and reads normally, no logs
- [x] Undeclared-conforming fixture reads via structural fallback with an
      undeclared-conformance info log (sheets predating adoption never regress)
- [x] Non-conforming fixture is refused at wiring time: `[]` returned, warn
      log carries the `ContractError` (`contract_unsatisfied` + issues), no
      throw
- [x] Pre-existing mealbank degrade tests stay green
- [x] `bun run build`, full `bun run test` (all packages), and
      `bun run check:skills` green

## Notes

- The shipped 2.5.0 API matches the plan's sketch: `contract.schema` accepts a
  parsed object (or JSON/TOML text + a `format` key — no auto-detection),
  `mode` defaults to `'verify'`, and `sheet.contractVerification` reports
  `{ name, rung, tree, conforming, issues }`. `onDrift` fires only for
  structural-verified sheets — declared sheets are covered by write-time
  enforcement going forward.
- Vendoring for the declared fixture goes through the real CLI
  (`gitsheets contracts adopt`) rather than baked-in canonical TOML bytes, so
  the fixture can never skew from the encoder's canonical form. `adopt` never
  edits the sheet config (`implements` is human-authored by design) — the test
  declares it in a follow-up commit, after a `git reset --hard` to re-sync the
  working tree with gitsheets' ref-only commits.

## Follow-ups

None.
