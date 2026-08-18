---
status: in-progress
depends: []
specs:
  - specs/modules/pages.md
issues: [211]
---

# Plan: scope the worksheet draft to (slug, instance), not slug alone

## Scope

Fix the worksheet runtime's client-side draft (`localStorage`, holding the
`submission_key` and last-entered quantities) so it stops surviving a
**republish**. Republishing is how a sheet gets corrected — new components,
new steps, new bindings — and it currently comes back pre-filled with the
prior run's numbers and prior idempotency key, so the next submit is treated
as a replay: it writes nothing and still shows "✓ Recorded".

- `renderWorksheetHtml` mints one opaque **instance token** per render call,
  carried on the `pw-definition` element as `data-pw-instance`.
- The client runtime's draft key becomes `(slug, instance)` instead of
  `slug` alone.

**Out of scope**: distinguishing a replay from a first write in the server
response (the issue's "worth considering alongside" — a real improvement, but
a separate contract change, not needed to close this bug); any database
schema change (the instance token is generated at render time and threaded
through HTML only — no migration).

## Implements

- **specs/modules/pages.md § The rendered document** — the new
  `data-pw-instance` attribute and what it's for.
- **specs/modules/pages.md § Idempotency** — the draft's `(slug, instance)`
  scope, why slug-alone under-scoped, and what stays true (a reload of the
  same rendered instance still finds its draft and retries the same key).
- **specs/modules/pages.md § Interaction with the restore affordance** — a
  republish now always falls through to the explicit,
  submitter-chosen `pagesLastResponse()` restore, never a silent unsent-draft
  pre-fill.

## Approach

**Why not the DB version id.** `renderWorksheetHtml(definition, title)` is
called and its HTML is fully formed *before* the store inserts the new
`pages.versions` row — the row (and its id) doesn't exist yet at render time.
Threading the real version id through would mean rendering twice (once to get
an id, once to embed it) or a post-insert HTML rewrite; both are more moving
parts than the problem needs.

**A per-render random token instead.** `renderWorksheetHtml` mints a
`crypto.randomUUID()` at render time and embeds it as `data-pw-instance` on
the `pw-definition` script element (a plain HTML attribute — the definition's
own embedded JSON, and the exact-JSON-equality test that pins it, are
untouched). This is stronger than a content hash: it resets the draft even
when a republish's content is byte-identical to what it replaced, matching
"a republish always starts fresh" exactly rather than "a republish starts
fresh only if something actually changed."

**The runtime keys its draft on `(slug, instance)`.** `draftKey`, `readDraft`,
and `writeDraft` in `helper-script.ts` take the instance token (read off
`pw-definition`'s `data-pw-instance` at init) alongside the slug. Everything
downstream — the submission-key survives-a-reload guarantee, the "Submit
again" mint-a-fresh-key behavior, the unsent-draft restore offer — is
unchanged in shape; it is now just partitioned per rendered instance instead
of per slug.

**A page rendered before this shipped has no `data-pw-instance` attribute.**
The runtime falls back to a fixed `'legacy'` instance label in that case. Its
in-flight draft (if any) under the old slug-only key simply isn't found under
the new key — equivalent to a reload after `localStorage` was cleared, not a
new failure mode. Not worth engineering around: it is a one-time, one-page
edge case at deploy time, and the worst outcome is a rare unfinished draft
losing its saved quantities, never a wrong write.

## Validation

- [x] A reload of the SAME published instance still finds its draft: the
      unsent-quantities restore offer fires, and a retried submit reuses the
      same `submission_key`.
- [x] A republished slug (a new rendered instance) does NOT restore the prior
      quantities and does NOT reuse the prior `submission_key` — pinned by an
      end-to-end test that evaluates the actual `HELPER_SCRIPT` source against
      a minimal fake DOM/localStorage/fetch (`helper-script.test.ts`), not a
      reimplementation of its logic.
- [x] `renderWorksheetHtml` mints a different `data-pw-instance` token on two
      calls with the identical definition (`worksheet.test.ts`).
- [x] The definition's own embedded JSON is unchanged byte-for-byte (the
      pre-existing exact-equality test still passes unmodified in assertion,
      only its matching regex was loosened to skip the new attribute).

## Risks / unknowns

- **The instance token is per-render, not per-content.** Two republishes with
  identical definitions still get distinct tokens, which is the intended
  behavior here (see Approach) but is worth naming as a deliberate choice: a
  content hash was considered and rejected because it would silently keep
  resurrecting a draft across a byte-identical republish, which is a real
  case (e.g. a republish only to bump `digest_optin` or fix a typo in `title`
  that isn't part of the worksheet definition at all).
- **The 'legacy' fallback key is a fixed string, not per-page.** If two
  different slugs are both served from pre-fix HTML while cached, they still
  partition correctly (the draft key still includes the slug), so this only
  collapses distinct pre-fix *instances of the same slug*, which cannot
  happen (there's only ever one current version per slug).

## Notes

The issue's suggested direction says "key the draft on (slug, version)".
`version` there reads naturally as "the page's version" but the definition's
own `version` field is a fixed wire-protocol constant, not a per-publish
counter, and the actual database `pages.versions.id` isn't available until
after the HTML that would need to carry it is already rendered. Implemented
as an equivalent-but-distinct per-render token instead — see Approach for why.

## Follow-ups

- **Issue #211's "worth considering alongside"**: the client cannot currently
  tell a replay from a first write, so a *legitimate* idempotent retry (same
  instance, network dropped, retried) and a bug both currently render as a
  plain "✓ Recorded". Distinguishing them in the response would let the page
  say "already recorded" instead. Left as a follow-up issue, not folded into
  this plan — it is a response-contract change, not a draft-scoping one.
