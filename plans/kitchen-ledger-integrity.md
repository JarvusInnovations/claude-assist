---
status: done
depends: [kitchen-module]
specs:
  - specs/modules/kitchen.md
  - specs/behaviors/http-not-found.md
issues: []
pr: 155
---

# Plan: Ledger integrity + CLI parity (counted depletion, recipe upsert/archive, no false 200s)

## Scope

Three defects found in real use, all of the same family: a write that looks like
it landed but didn't, or a correction with no path to make it.

1. **`entries patch` panel parity.** The eight-field nutrition panel is
   patchable server-side (route schema + pipeline both accept all eight), and the
   CLI parses all eight — but the **documented** usage in `axi/reference.ts`
   (which is the CLI's `--help` *and* the spliced SKILL.md reference) enumerates
   only six, omitting `--sugar` and `--fiber`. An agent reading the reference
   concludes fiber/sugar cannot be corrected and falls back to `delete` +
   re-`log`, which mints a new ULID and destroys the entry's identity. Both are
   tracked daily targets, so they are among the most correction-worthy fields.
   Fix the documented surface and make the flag list single-source so `log` and
   `patch` cannot drift apart again.

2. **`POST /recipes` forks instead of replacing, and nothing can be retired.**
   Pushing an identically-named recipe creates a second row. The strip taps
   recipes by name, so the two are indistinguishable and the stale one keeps
   logging wrong numbers. There is no delete at all. Add name/ulid upsert
   semantics and an archive path (§ Recipe corrections).

3. **Unmatched non-GET requests answer `200` with the SPA shell.** `/kitchen/*`
   is the admin SPA's client-side route space, so the host's not-found handler
   serves `index.html` for any unmatched path — including `DELETE`. A write that
   never happened reads as success to any API client. General correctness trap,
   not kitchen-specific (`specs/behaviors/http-not-found.md`).

4. **Counted inventory items never decrement on consumption.** The depletion
   matcher only ever moves `on_hand_fraction`, a field nothing reads on a counted
   item — so a counted multipack sits at its purchase count while the shelf
   empties, every consumption logged in the journal and none of it in the ledger.
   Counting was supposed to be the *exact* alternative to an eyeballed fraction;
   today it is the least trustworthy of the two and, unlike a fraction, it
   doesn't advertise that it's a guess.

**Out of scope:**

- **Recipe-component → product → item fan-out depletion.** An entry logged
  against a recipe with several tracked components still depletes at most the one
  item its *label* matched. Fan-out needs a per-(entry, item) link with
  per-component quantities — `entries.inventory_item_ulid` is single-valued, and
  without a per-pair key there is no idempotency key to check — so it is separate
  work with its own migration. Stated as deliberately-out-of-scope in the spec so
  the matcher doesn't read as if it does more than it does.
- Changing the depletion step constant, the match scoring, or making the matcher
  model-assisted. Conservative label matching stays as-is.
- Backfilling already-drifted counts, or de-duplicating recipe forks that predate
  the upsert. Both are one-shot data corrections; the upsert refuses to guess
  which existing fork is canonical (`409`) rather than silently picking one.
- Hard-deleting recipes. Archive only (§ Recipe corrections).

## Implements

- `specs/modules/kitchen.md` § Recipe corrections — upsert-on-name, explicit
  `ulid` replace, the cross-source `409`, archive-not-delete, and the two local
  principles (a correction replaces rather than forks; retire by state).
- `specs/modules/kitchen.md` § API — the amended `POST /recipes` line and the new
  `DELETE /recipes/:ulid`.
- `specs/modules/kitchen.md` § Depletion matcher — unit-model-aware decrement,
  the already-linked idempotency guard, and the out-of-scope fan-out note.
- `specs/modules/kitchen.md` § Data Requirements (Recipes `archived_at`).
- `specs/modules/kitchen.md` § Agent tooling — `log`/`patch` share one macro-flag
  source; `recipes push` upserts and `recipes delete` archives.
- `specs/behaviors/http-not-found.md` — the whole file (new).

## Approach

- **Panel parity**: move the eight `flag → field` pairs into `axi/reference.ts`
  as the single source, build both the `log` and `patch` usage strings from it,
  and import it in `commands/entries.ts` for the parse lists. Rebuild the bundle
  and SKILL.md via `build:skills`.
- **Recipe upsert/archive**: `archived_at TIMESTAMPTZ` migration; `RecipeStore`
  grows `findLiveByNormalizedName`, `replace`, `archive`; `list()` filters
  archived while `get()` does not (history must keep resolving).
  `KitchenPipeline.pushRecipe` does the resolution and throws a typed conflict
  the route maps to `409`; `archiveRecipe` returns null for unknown/sheet ULIDs →
  `404`. Mirror in `MemoryRecipeStore`. CLI: `recipes push [--ulid U]`,
  `recipes delete <ulid>`.
- **False 200**: a pure `resolveUnmatchedRequest({ method, url, accept })` helper
  in `apps/server/src` returning `json-404 | spa-shell`, wired into
  `setNotFoundHandler`; unit-tested directly (the server entrypoint is a script,
  not a factory). Tighten the `/api` check to a whole path segment while there.
- **Counted depletion**: `matchAndDeplete` branches on the matched item's unit
  model — `finished-unit` semantics via the existing `applyEventToRecord` for
  counted items, the directional fraction step otherwise — and returns early
  when the entry already carries an `inventory_item_ulid`. The hook passes that
  field through. Failures stay best-effort no-ops (the matcher must never break
  an entry).

## Validation

- [x] `entries patch --sugar N` / `--fiber N` set a terminal manual override on
      those fields, and the documented usage for both `log` and `patch`
      enumerates all eight panel flags (test asserts every flag appears in both,
      so the pair cannot drift).
- [x] `check:skills` green — the committed bundle and SKILL.md match the source.
- [x] `POST /recipes` with a new name creates (`201`); the same normalized name
      again replaces in place (`200`, same ULID, updated components) instead of
      forking; `GET /reselect` shows one pill.
- [x] A push whose name collides with a `promoted` or `sheet` recipe `409`s
      naming the colliding ULID + source; nothing is written.
- [x] A push with an explicit `ulid` replaces that record (preserving its
      `source`) or creates it, idempotently.
- [x] `DELETE /recipes/:ulid` archives: the recipe leaves `GET /reselect` and the
      merged listing, `GET` by ULID still resolves it, an entry that references it
      still resolves for promote/consume, a repeat DELETE is idempotent, and an
      unknown or sheet-sourced ULID `404`s.
- [x] Unmatched-route matrix: `GET /api/nope` → `404` JSON; `DELETE
      /kitchen/recipes/x` → `404` JSON (no HTML, no `200`); `GET /kitchen/x` with
      `Accept: application/json` → `404` JSON; `GET /kitchen/x` with
      `Accept: text/html` → the SPA shell; `/apiary` is not treated as API space.
- [x] A logged entry matching a **counted** item decrements `units_remaining` by
      exactly one whole unit (not the fraction), reverting the item to `stocked`
      with an unopened-window `eat_by`; the last unit goes terminal `finished`.
- [x] A logged entry matching a **fraction** item still steps
      `on_hand_fraction` (regression).
- [x] Idempotency: an entry that already carries `inventory_item_ulid` is not
      depleted again — a re-queue → re-estimate cycle takes no second unit.
- [x] A matched-item depletion failure leaves the entry intact (best-effort).
- [x] Full suite green: `bun test`, `bun run build`, `bun run type-check:axi`,
      `bun run check:skills`.

## Risks / unknowns

- **Counted decrement of one unit per matched entry** assumes one entry = one
  serving = one sealed unit. Correct for the multipack case that motivated this
  and consistent with the per-serving recipe convention § Consume from inventory
  settled on, but an entry that really was two units will under-deplete by one.
  Directional-and-self-healing (a `recount` fixes it) is the module's existing
  stance; noted rather than solved.
- **The `Accept`-based JSON preference** in the not-found handler is the one rule
  with any chance of surprising an existing caller. Kept narrow: it fires only
  when the client named a JSON type and no HTML type, so `*/*` and browsers are
  untouched.
- **Cross-source name collision as a `409`** is stricter than silently allowing a
  duplicate. Deliberate — a duplicate name is precisely the defect — but a caller
  that legitimately wants a pushed variant of a sheet recipe now has to rename
  it. Acceptable: renaming is what makes the two tappable apart anyway.

## Notes

- **Defect 1 was narrower than reported, and the fix is correspondingly narrow.**
  `--sugar`/`--fiber` were already parsed by `entries patch` and already accepted
  by the route schema and the pipeline — the gap was purely the *documented*
  surface (`axi/reference.ts` → `--help` → the spliced SKILL.md), which named six
  of eight. That is still the whole defect from a caller's point of view: an agent
  reads the reference, concludes the flag doesn't exist, and reaches for
  delete + re-log. The durable fix is that the flag list now lives once
  (`MACRO_PANEL_FLAGS`) and generates both usage strings plus both parse lists, so
  the pair can't drift again; a test asserts all eight appear in both usages.
- **Recipe upsert semantics as built**: `ulid` supplied → create-or-replace that
  record, preserving `ulid`/`created_at`/`source`; otherwise the normalized name
  (case-folded, whitespace-collapsed) resolved against LIVE DB recipes only.
  `201` create, `200` replace, `409` for a `promoted`/`sheet` collision or several
  pushed forks — with every candidate ULID + source named in the message. A
  sheet-name collision refuses too: the sheet can't be replaced from here, and
  allowing a pushed twin under the same name recreates exactly the ambiguity the
  upsert exists to remove. Archiving frees the name again (next push creates).
- **Delete-vs-archive**: archive, uniformly, no hard delete. `list()` filters
  `archived_at IS NOT NULL`; `get()` deliberately does not. That asymmetry is the
  load-bearing part — the strip, the merged view, and the briefing's suggestions
  all read `list()`, while an entry's `recipe_ulid`, promote's component
  reconstruction, and a derived item's consume eligibility all read `get()`.
- **Defect 4 landed fully for the label-matched path, NOT as the drift-detection
  fallback.** The matcher's decrement is now unit-model-aware
  (`finished-unit` semantics for a counted item, the directional fraction step
  otherwise), so counted items move for the first time. The fallback wasn't
  needed: the root cause was one branch, not an unbuilt resolver. Recipe-component
  fan-out remains unbuilt and is now stated as out-of-scope *in the spec* rather
  than left as an implied capability.
- **Idempotency was missing for fractions too** and is fixed for both: the matcher
  returns early when the entry already carries an `inventory_item_ulid`. A
  note/label PATCH re-queues estimation, so the hook genuinely fires twice per
  corrected entry (a new pipeline test asserts that it does) — every such
  correction was previously taking another step off the shelf. The hook now hands
  the matcher the whole `EntryRecord` rather than a field-picked subset, since a
  hand-written pick is how that key would get dropped again.
- **The false-200 fix is host-wide, not kitchen-scoped**, and is its own commit
  against its own new behavior spec. Chose `404` over `405` for the wrong-verb
  case deliberately: nothing exists at an unmatched path under any verb, and
  `405` would assert that it does. The `Accept`-based rule is kept narrow (a named
  JSON type and no HTML type), so browsers and `*/*` clients are untouched.
- Verified independently before opening the PR: `bun run test` → every workspace
  package `0 fail` (kitchen 395 pass, server 6 pass — a new package `test` script,
  since `apps/server` had none); `bun run build` exit 0; `bun run type-check:axi`
  clean; `bun run check:skills` reports all four bundles and SKILL.mds up to date;
  full-diff and commit-message scrub scan clean.
- **Migration `015-kitchen-recipe-archive.sql` has not been run against a live
  database** — it is additive (`ADD COLUMN IF NOT EXISTS` + a partial index) and
  applies on next boot.

## Follow-ups

- **Deferred to its own plan — component-level depletion.** One entry depleting
  one item per tracked recipe component needs a `(entry, item)` link table
  carrying each decrement's quantity and kind; `entries.inventory_item_ulid`
  cannot express it, and without a per-pair key the idempotency guard has nothing
  to check. Wants its own migration, its own ambiguity policy (eat-first order
  vs. honest refusal per component), and an honest partial-success wire shape.
- **Deferred — `POST /entries/:ulid/promote` can still mint a same-named fork.**
  The upsert covers `POST /recipes` only, which is what the spec now states.
  Promote deliberately always inserts (it records a specific logged meal), but
  promoting twice under one name reintroduces the indistinguishable-pill problem
  the upsert just removed. Decide whether promote should upsert, suffix, or refuse.
- **Tracked here, not fixed — test isolation via ambient `TZ`.** The weigh-ins
  local-offset assertion only passed because a sibling test file sets
  `process.env.TZ` at import time; it broke as soon as it ran without that file
  loaded. Normalized the `-0` comparison so it passes either way, but the
  cross-file TZ leak remains: any test in the package can be affected by that
  import-time mutation, and it would be better as an explicit per-test fixture.
- **None** for the recipe forks and drifted counts that already exist in a running
  instance — the upsert refuses to guess which fork is canonical and the matcher
  only decrements forward, so both are one-shot operational data corrections
  (`recipes delete` for the stale fork, `inventory` recount for the count),
  deliberately out of this plan's code scope.
