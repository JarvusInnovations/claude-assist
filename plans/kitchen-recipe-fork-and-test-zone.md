---
status: done
depends: [kitchen-ledger-integrity]
specs:
  - specs/modules/kitchen.md
issues: []
pr: null
---

# Plan: Close the promote fork hole + make the test zone an explicit invariant

## Scope

Two of the three follow-ups [kitchen-ledger-integrity](kitchen-ledger-integrity.md)
recorded on closeout. Both are cases where the earlier fix was correct but
incomplete — one closed the front door and left the side door open, the other
depended on an accident.

1. **`POST /entries/:ulid/promote` could still mint a same-named fork.** The
   `POST /recipes` upsert closed the fork hole for pushes, but promote is the
   other write path into the recipe table and it was a blind insert. Promoting
   twice under one label produced two `promoted` recipes with the same name —
   the identical indistinguishable-pill failure, reached through a different
   route (§ Recipe corrections).

2. **A `process.env.TZ` mutation at import time leaked across the package.**
   `date-coerce.test.ts` set the zone at module scope. Bun shares one process
   across a package's test files, so the mutation reached every other suite and
   made their correctness depend on **file load order**. The previous plan
   normalized a `-0`/`0` weigh-ins assertion that only passed because of it; the
   leak itself survived and could silently prop up any assertion in the package.

## Decisions

**Promote refuses; it does not replace.** A push can replace by name because the
caller supplies the numbers. A promoted recipe is the record of *one* entry's
resolved macros, so replacing one derived from a different entry would silently
rewrite it with unrelated numbers. Remedy is an explicit `name` in the body, or
archiving the existing recipe (which frees the name — the check only sees live
rows).

**Scoped to `promoted` collisions only.** The first implementation refused on any
live name collision, and five existing tests immediately failed — correctly. An
entry logged *from* a recipe carries that recipe's name by construction, and
promoting it is an intended flow that `reconstructComponents` exists to serve.
Refusing there would have broken real behavior to fix a narrower bug. So a
`pushed`/`sheet` twin is permitted, which knowingly leaves a smaller ambiguity
alive (one `pushed` + one `promoted` under one name). Collapsing names across
sources is a broader design question, recorded in the spec as explicitly not
decided rather than settled by side effect.

**The test zone is pinned by preload, not by `[test] env`.** `bunfig.toml`'s
`env` table was tried first and **does not work** for `TZ` — it lands too late to
affect `Date` construction, and the zone-dependent suites still failed under it
(8 failures). A `preload` script setting `process.env.TZ` before any test file is
imported does work. The pin belongs package-wide because the assertions it
supports are deliberate: an offset tracking the *dated* day across a DST boundary
is the bug class they guard, and that needs a known zone.

## Validation

- `bun run test` — every package `0 fail`; kitchen **398 pass** (was 395: +3 promote
  conflict cases), server 6, capture 100, pages 56, session-spawn 19, chat 10.
- `bun run build` exit 0; `bun run type-check:axi` exit 0; `bun run check:skills`
  reports all 4 SKILL.mds up to date.
- **Leak proven fixed, not masked.** `date-coerce.test.ts` no longer sets `TZ`
  itself and passes **alone** (13/13), and passes under a hostile ambient zone
  (`TZ=Asia/Tokyo`). `weigh-ins.test.ts` likewise passes alone under
  `TZ=Asia/Tokyo` — previously it only passed when `date-coerce` happened to load
  first.
- New promote cases: refuses a second promote under a held name and leaves the
  first recipe's macros intact; succeeds with an explicit name; succeeds again
  once the colliding recipe is archived.

## Notes

The `[test] env` dead end is worth remembering — it looks like the obvious
mechanism and fails silently in the direction of "tests still pass because
something else is setting the zone."

## Follow-ups

- **`convert` still performs three non-transactional writes** (source
  decrements, then the derived-item insert, then the derivation insert). A
  mid-sequence failure leaves sources spent with no derived item — food
  disappears from the ledger. `services/consume-store.ts` already establishes the
  pattern (one `sql.begin` spanning both writes, with an in-memory analogue in
  `consume-memory-store.ts`), so this is a known shape rather than a design
  question: a `convert-store.ts` plus its memory twin and the wiring. Tracked
  upstream as claude-assist#116 and **deliberately left for its own plan** — it
  is a new store layer, not a patch.
- Collapsing recipe names across sources (see Decisions) remains undecided.
