---
status: done
depends: [pages-admin-tab, entries-direct-panel, convert-atomicity]
specs:
  - specs/modules/pages.md
  - specs/modules/kitchen.md
issues: [129, 130]
pr: 167
---

# Plan: The worksheet response pattern + kitchen cook mode

## Scope

Two changes to the pages module, plus the kitchen-side sink they exist for.

1. **Charset (#129).** Serve every body from the public pages surface with an
   explicit `charset=utf-8`. Small, and it goes first because it currently
   corrupts every non-ASCII glyph a worksheet renders — a mangled `°F` in a
   cooking instruction is a wrong number, not a cosmetic defect.
2. **The worksheet response pattern (#130, layer 1).** Promote the
   weighable-components page from convention to contract: publish the worksheet
   as **data**, render the one canonical document from it, validate submissions
   against the published definition, and compute the totals **server-side**.
3. **Cook mode (#130, layer 2).** A worksheet may declare that submitting it IS
   the log — landing on the kitchen module's *existing* endpoints: a
   directly-stated panel entry when eaten, a `convert` when packed.

**Out of scope:**

- **A generic form builder.** One typed pattern (weighable components → named
  numeric totals), one renderer, one submit. Anything else publishes its own
  HTML on the untouched path.
- **The item state model, price/waste surfaces, and the estimator** — all owned
  by concurrent work.
- **Per-batch measured macros for a packed item.** A packed batch's consume-time
  macros still come from its linked recipe, because `derived_from.recipe_ulid` is
  the only macro-inheritance channel; carrying the *measured* weights through to
  eat time needs a per-batch recipe or item-level macros. Stated as a limitation
  in the spec, listed as a follow-up.
- **Any data migration.** Additive nullable column only; applies on next boot.
- **A `pages-axi` worksheet-publish flag.** The HTTP surface is the contract;
  a CLI ergonomic sits on top of it and can land separately.

## Implements

### `specs/modules/pages.md`

- § Serving surface § Encoding — the explicit charset on every served body.
- § Data model — the `worksheet` JSONB column on `pages.versions`, and why it
  hangs off the version rather than the page.
- § The worksheet response pattern — the definition (request half), the
  submission (response half), the totals formula and its null semantics, the
  normalized stored payload, the rendered document, idempotency, what the
  submitter sees, and the restore affordance's continued behavior.
- § Cook mode — the directive, the two dispositions, the injected sink, and the
  order of writes with a stated outcome per failure point.
- § API surface — the amended `POST /api/pages` body and the response-ingest
  status codes (`400` / `502` / `503`).
- § Principles (local) — the three new rules: the server computes what the page
  displays; a writing submit must say so unambiguously; a failed side effect
  degrades to the queue, never to silence.

### `specs/modules/kitchen.md`

- § Cook mode — the whole section: the disposition→endpoint mapping, panel
  validation, the one-atomic-write rule, and the seam.
- § Conversions § Retries — amended: an optional caller-supplied `derived.ulid`
  is the conversion's idempotency key, with the before-validation ordering rule
  and the in-transaction net.
- § API `POST /inventory/convert` — the amended body, response, and 201/200.
- § Directly-stated panel entries — a pointer to its first in-system caller.
- § Principles (local) — "Packing is a conversion; eating is an entry."

## Approach

### Charset

`reply.type()` with the parameter spelled out, on the page, the index, the
helper, and the 404 body. Take an optional injected `store` on the public routes
so the serving surface is testable without Postgres.

### Worksheet contract (`packages/pages/src/worksheet.ts`)

One module owning the whole typed pattern:

- `validateWorksheetDefinition(raw)` / `validateWorksheetSubmission(raw, def)` —
  hand-written validators that throw `WorksheetValidationError` naming the
  offending path, because a nested per-component reference table is exactly where
  a generic JSON-Schema failure is useless. Unknown keys are rejected, including
  a client-supplied `totals`.
- `computeWorksheetTotals(def, quantities)` — Σ `quantity / basis × per_basis[k]`,
  rounded per field. A component omitting a field contributes *unknown*; the
  total is null only when no component carried it. An omitted component keeps its
  planned quantity.
- `normalizeWorksheetResponse` — the canonical stored payload (resolved
  quantities + the references + the totals), so a consumer reads and is done.
- `renderWorksheetHtml` — the one document. Definition embedded as JSON (with
  `<` escaped), driven by the shared runtime; every string HTML-escaped.

Persistence: migration `002-worksheet.sql` adds a nullable `worksheet JSONB` to
`pages.versions`; `PublishInput` / `PageVersionRecord` / `getCurrent` carry it
through both store implementations.

### Client runtime (`helper-script.ts`)

Extend `_helper.js` (no breaking change) with `pagesWorksheetInit()`: live totals
mirroring the server formula (display only), a ULID submission key persisted in
`localStorage` so a reload retries the *same* submission, an explicit
success/failure status panel with a Retry button, and the restore affordance
offered — never auto-applied.

### Cook seam

- Core owns the kitchen-type-free `WorksheetCookSink` / `WorksheetCookRequest` /
  `WorksheetCookOutcome` and the new `PagesPluginConfig.worksheetCookSink`.
- `packages/kitchen/src/services/cook-mode.ts` implements it: `eaten` →
  `pipeline.ingest({ ulid, macros, label, note })`; `packed` →
  `inventory.convert({ sources, derived: { ulid, … } })`. Totals keys validated
  against `NUTRITION_FIELD_KEYS`; an unknown key throws rather than being
  dropped.
- Kitchen decorates `fastify.kitchenCookMode`; the server injects it into
  `pagesConfig`. Registration order already has kitchen before pages.

### Convert idempotency

`ConversionDerivedInput.ulid?` becomes the conversion's idempotency key.
`convert()` pre-checks **before** any validation against current state (a replay
must not 409 against its own side effect), and `applyConversion` repeats the
check inside its transaction as the race net. `ConvertResult.created` drives
201/200 at the route. An existing item with no derivation row is a `400`, not a
fabricated replay.

### Response ingest ordering

Append the response row **first**, then call the sink, then mark processed. A
sink failure therefore leaves the numbers durable and the row unprocessed — the
module's existing needs-attention signal — with the notify escalated out of the
digest tier.

## Validation

- [x] `GET /pages/:slug` responds `text/html; charset=utf-8`; the index, the
      helper, and the 404 body each carry a charset too.
- [x] A body containing em dash, `°`, `✓`, `×`, `≈`, `·`, `é`, and `→` round-trips
      byte-for-byte through publish → serve, decodes as strict UTF-8, and contains
      no replacement character.
- [x] `validateWorksheetDefinition` rejects each malformed shape (wrong kind,
      future version, empty fields/components, non-identifier field key, an
      undeclared `per_basis` key, duplicate component labels, unknown top-level
      keys) and names the offending path.
- [x] `validateWorksheetSubmission` rejects a non-ULID key, an undeclared
      component, a duplicated component, an out-of-range quantity, and a
      client-supplied `totals`.
- [x] `computeWorksheetTotals` matches a hand-checked fixture, both at planned
      quantities and at stated ones; a field no component carries is `null`; a
      stated `0` totals `0`; an omitted component contributes its planned
      quantity.
- [x] Publishing with a `worksheet` stores the definition on the version and
      renders a document whose non-ASCII steps survive; both-or-neither of
      `html`/`worksheet` is a `400`.
- [x] A malformed submission `400`s and appends **nothing**.
- [x] A free-form payload on a worksheet page, and a worksheet payload on a
      non-worksheet page, are both stored verbatim.
- [x] Cook mode `eaten` produces exactly one born-`manual` entry carrying the
      stated panel and converts nothing.
- [x] Cook mode `packed` produces exactly one conversion (derived ULID = the
      submission key, recipe + sources + units carried) and **no** entry.
- [x] A double-submit under the same key writes once and reports
      `already-logged` / `created: false`, at both the pages layer and the
      kitchen layer; a new key writes again.
- [x] `applyConversion` replays a caller-supplied derived ULID by writing
      nothing — sources unchanged, one item, one derivation — including when the
      first attempt already drove a source terminal.
- [x] A resubmission appends a new response row and leaves the earlier one
      byte-identical.
- [x] A failed cook-mode write returns `502`, stores the computed totals, leaves
      the row unprocessed, and notifies at `notice` even for a digest-opted page;
      a retry under the same key then succeeds exactly once.
- [x] No sink wired → `503` with `status: 'unavailable'`, never a silent success.
- [x] `bun run test`, `bun run build`, `bun run type-check:axi`,
      `bun run check:skills` all green.

## Risks / unknowns

- **Concurrent work in the same files.** Three sibling plans are touching the
  item state model, price/waste, and the estimator. `inventory-store.ts`,
  `inventory-memory-store.ts`, and `services/inventory.ts` are the likely
  collision points; expect to rebase rather than merge.
- **Amending a stated non-feature.** § Conversions § Retries previously declared
  convert's non-idempotence deliberate. Making it opt-in preserves the default
  it argued for, but the amendment has to be explicit in the spec rather than a
  quiet reversal.
- **Two implementations of one formula.** The client recomputes totals for the
  live display. Mitigated by making the server's numbers the only ones stored and
  saying so in the spec, but a drift between the two would show as a display that
  disagrees with the record — the thing the pattern is meant to prevent.
- **`escapeHtml` duplicated** between `worksheet.ts` and `routes/public.ts`.
  Small, and the two have different call sites; worth folding together if a third
  appears.

## Notes

- **Amending a stated non-feature.** § Conversions § Retries had argued convert's
  non-idempotence was deliberate and that a caller-supplied derived ULID was
  "deliberately not part of it." Cook mode is the caller that changes the
  calculus, so the section is amended in place with a dated note rather than
  quietly reversed — the *default* it argued for is preserved, and idempotency is
  opt-in.
- **One pre-existing test was amended, not just added to.** The
  `applyConversion` case "rolls back when the derivation insert itself fails"
  reused the derived ULID to provoke the collision; that path is now an idempotent
  replay. The genuine `UNIQUE(derived_item_ulid)` rollback it covered is retained
  under a real collision (a fresh derived item whose derivation points at an
  already-provenanced one).
- **The disposition is fixed at publish, and that was a judgment call.** Letting
  the submitter choose at submit time is arguably more honest about plans
  changing, but it costs the confirmation its certainty ("one submit, one
  consequence") and starts down the form-builder road. A sheet whose destiny
  changes is a republish, which is free because versions are retained.
- **Two implementations of the totals formula** (server authoritative, client for
  live display) is a knowing duplication. Mitigated by storing only the server's
  numbers and saying so in the spec; a genuine drift would surface as a display
  disagreeing with the record.
- **`escapeHtml` is now duplicated** between `worksheet.ts` and
  `routes/public.ts`. Left alone at two call sites; worth folding if a third
  appears.
- **A flaky pre-existing test**, `packages/kitchen/src/services/mealbank.test.ts`,
  timed out its 5 s `beforeAll` on one local run (three `gitsheets` CLI spawns in
  one hook) and failed identically on an untouched `main` checkout. It passed on
  every subsequent run. Not caused by this plan; noted in case it recurs in CI.

## Follow-ups

- Tracked as: **per-batch measured macros for a packed item.** A packed batch's
  consume-time macros still come from its linked recipe, since
  `derived_from.recipe_ulid` is the only macro-inheritance channel — so a batch
  weighed materially off-recipe logs the recipe's numbers when eaten. The measured
  weights are recorded (derived-item `notes` + the response payload) but not
  *inherited*. Closing that needs either a per-batch recipe minted from the
  worksheet or item-level macros, both of which touch the item model; the
  limitation is stated in `specs/modules/kitchen.md` § Cook mode so it can't be
  mistaken for an oversight.
- Tracked as: **a `pages-axi` worksheet-publish ergonomic.** The HTTP surface is
  the contract and is complete; a CLI flag that takes a worksheet JSON file is
  additive convenience and can land on its own.
- Tracked as: **the app-side cook-mode screen** lives in the capture app repo, per
  the issue's own note; nothing in this repo blocks it.
