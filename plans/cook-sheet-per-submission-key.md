---
status: done
depends: [worksheet-draft-scoped-to-instance]
specs:
  - specs/modules/pages.md
  - specs/modules/kitchen.md
issues: [263, 228, 219]
pr: 269
---

# Plan: a cook sheet's idempotency key is minted per submission, and the submit response says what moved

## Scope

A cook-mode worksheet's `submission_key` outlived one submission: the page
runtime persisted it in the draft after a *successful* write, so the next
submit from the same rendered page — a day later, with that day's weights —
carried the same key and was deduplicated as a replay. No entry, no
decrement, a green check. Observed in a production instance on a reused
breakfast sheet.

In scope:

- **Runtime**: mint the key per submission at submit time; retire it from
  the persisted draft the moment a write is confirmed; render a `409` as its
  own state with a "Submit as new" affordance.
- **Pages server**: compare a reused key against the stored payload it
  recorded — identical → replay with the original result; different →
  `409`, nothing appended; store the sink's result on the processed row so a
  replay can answer with it.
- **Kitchen sink**: return structured `decrements` (applied + unapplied with
  reasons) in the outcome; refuse a replayed key whose stated panel differs
  (conflict, not replay).
- **Page**: the confirmation lists the entry written (label, totals, ULID),
  every decrement applied, and every decrement NOT applied with its reason.

Out of scope, with reasons:

- **Locking a sheet after one submit.** Reuse is the first-class flow the
  bug broke; a lock would make the bug policy.
- **Refusing a mass-basis-less component at publish time** (#228's second
  suggestion) — a separate authoring-side change; this plan makes the
  submit-time refusal visible, which is the half #228 and #219 share.
- **Marking recipe-seeded rows as untracked at publish** (#219 option 2) —
  the submit response now says what did not decrement, which covers the
  symptom; the publish-time note is still a worthwhile follow-up.
- **The stated-weight path's `entry_ulid` replay guard** (#174) — untouched.

## Implements

- `specs/modules/pages.md` § Idempotency — per-submission minting, key
  retirement on confirmed write, the same-key payload table (`409`), legacy
  pages need no republish.
- `specs/modules/pages.md` § What the submitter sees — the conflict state,
  the result listing (entry + applied + unapplied), `409` in the status table.
- `specs/modules/pages.md` § The cook seam — `decrements` on the outcome; a
  sink conflict maps to `409`.
- `specs/modules/pages.md` § Order of writes — step 0 (key check) and the
  stored result at step 3.
- `specs/modules/kitchen.md` § Cook mode (Idempotency) — one key per
  submission; replayed key with a different panel is a conflict.
- `specs/modules/kitchen.md` § An unapplied decrement is VISIBLE — the
  submit response carries applied/unapplied and the page renders them.

## Approach

**Runtime (`helper-script.ts`).** The draft holds `submission_key` only
while a submission is pending. `submit()` uses the pending key if there is
one (a retry after failure), else mints a ULID. On `201` the draft is
removed — the key is retired, and the restore affordance falls through to
`pagesLastResponse()` as a republish already does. On `409` the pending key
is dropped (quantities kept) and the panel shows the server's message with a
"Submit as new" button, which is just `submit()` with no pending key.
`pagesRespond` attaches `status` and the parsed body to the thrown error so
the runtime can tell a `409` from a `502`. The success panel renders the
label + totals (from `def.fields`), each applied decrement, and each
unapplied one with its reason.

**Pages server (`routes/api.ts`, store).** Before appending a cook-mode
worksheet submission, look up prior responses on the slug with the same
`submission_key` whose `processed_by` is a cook-mode marker. If one exists,
compare a canonical fingerprint of `{components[label,quantity], totals,
note}`; mismatch → `409 { error, conflict: { submission_key, recorded_at } }`
with nothing appended. Match → proceed (the sink is idempotent and reports
`created: false`), and the response carries the prior row's stored `result`.
A sink error carrying `code: 'worksheet_cook_conflict'` also maps to `409`.
Migration `004-response-result.sql` adds `result JSONB` to
`pages.responses` and an expression index on `payload->>'submission_key'`;
`markProcessed` gains an optional `result`.

**Core seam (`plugin.ts`).** `WorksheetCookOutcome.decrements?` with
`applied[]` / `unapplied[]`; `WorksheetCookConflictError` with a stable
`code`, so the pages module can recognise it without importing the kitchen.

**Kitchen sink (`cook-mode.ts`).** `applyConsumes` returns structured
applied/unapplied; the outcome carries them; `flagUnappliedDecrements` still
receives the human-readable strings. On `created: false` from the entry
ingest, compare the existing record's nutrition fields with
`totalsToStatedMacros(totals)`; any difference throws the conflict error.

## Validation

- [x] Two submissions from one sheet with different weights and different
      keys write two entries and two decrement sets (pages route, kitchen
      sink against the real inventory pipeline).
- [x] A network-retry replay of an identical submission writes one entry and
      reports `already-logged` with the original decrements.
- [x] Same key, different payload → `409`, nothing appended, the sink not
      called; the sink's own conflict error also surfaces as `409`.
- [x] A refused decrement appears in the submit response's
      `cook_mode.decrements.unapplied` with its reason, and the runtime
      renders it.
- [x] After a confirmed write the runtime's draft no longer carries the key:
      a reload of the same instance and a second submit post a fresh key.
- [x] A `409` renders its message and the next tap submits under a new key.
- [x] `packages/pages` and `packages/kitchen` suites green; package builds and
      `type-check:axi` pass.

## Risks / unknowns

- **Fingerprint strictness.** The comparison covers quantities, totals, and
  the note. A submitter who retries after a `502` having edited a number
  gets a `409` instead of a retry — correct (it is a different submission)
  and recoverable in one tap, but it is a behaviour change worth knowing.
- **Pre-migration rows carry no stored result.** A replay of a submission
  recorded before this shipped reports `already-logged` with empty
  decrements rather than the original list. Acceptable: the write itself
  is still reported honestly.
- **Legacy drafts.** A page whose persisted draft still holds a recorded key
  hits the `409` once, then proceeds under a fresh key. Message names the
  republish fallback in case the draft is somehow re-seeded.

## Notes

- **The "fixed per page" key was the persisted draft, not a publish-time
  field.** Nothing in the worksheet definition or the `prep` publisher mints
  a ULID; `cook_mode.ulid` exists only in the stored payload and equals the
  submission key. The runtime's `settled` flag (mint a fresh key on the next
  tap after success) was in-memory only, so a reload lost it while the draft
  kept the key. Because the runtime is served live from `/pages/_helper.js`,
  already-published sheets pick up the fix with no republish.
- **No payload-hash column.** The normalized payload is stored on the row, so
  the fingerprint is computed from it on both sides of the comparison; the
  one migration adds `pages.responses.result` (the cook report) and a lookup
  index on `payload->>'submission_key'`.
- **The fingerprint deliberately excludes per-basis references and the cook
  directive** — those come from the published definition, not the submitter.
- **The kitchen sink's conflict check covers `eaten` only.** `convert`'s
  replay return carries no comparable panel; the pages-side check covers
  packed sheets, and the sink-side one is the second line of defence for the
  landed-but-unmarked case.
- **The fake DOM in `helper-script.test.ts` now clears children on
  `textContent` assignment**, as a browser does; without that the status
  panel's history accumulated and every assertion on it read the first
  render. The flush helper drains macrotasks rather than three microtasks.

## Follow-ups

- **Issue** — #228 (second suggestion): refuse a gram-bound component whose
  product has no mass basis at publish time, where the failure is recoverable
  before the food is gone. Still open; this plan made the submit-time refusal
  visible.
- **Issue** — #219: a publish-time note (once per sheet) when no component on
  a `--cook` sheet is stock-bound. The confirmation's "No stock was
  decremented" line now covers the symptom at submit time; the publish-time
  signal is still worth adding.
- **None** — #174 (`entry_ulid`-less stated-weight replay) is untouched by
  design and remains tracked on its own issue.
