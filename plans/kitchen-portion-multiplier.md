---
status: done
depends: [kitchen-module]
specs:
  - specs/modules/kitchen.md
issues: []
pr: 94
---

# Plan: Kitchen portion multiplier (post-hoc base rescale)

## Scope

Add a post-hoc `portion_multiplier` to kitchen consumption entries: after a meal
is logged, the owner can say "I only ate half of that" (and later revise to "more
like ¾") without editing each macro field. Implements the § Portion multiplier
section added to `specs/modules/kitchen.md`.

**Out of scope**: the Flutter capture client's rendering + correction-sheet UI,
tracked separately in the client repo.

## Implements

- **specs/modules/kitchen.md § Portion multiplier** — the base-vs-effective wire
  rule (base on the wire, consumers multiply), the idempotent rescale-from-base
  invariant, and the orthogonality to source / note-modifier / manual override.
- **§ Data Requirements** — `kitchen.entries.portion_multiplier NUMERIC NOT NULL
  DEFAULT 1` (migration `003-kitchen-portion-multiplier.sql`), carried on
  `EntryRecord`.
- **§ API — PATCH /entries/:ulid** — accepts `portion_multiplier` (0 < m ≤ 20) on
  any entry regardless of source; never re-queues estimation, never changes
  `source`, never 409s; may ride alongside a macro override.
- **§ Integration seams — Renderings** — the briefing daily totals sum
  **effective** macros (`SUM(macro * portion_multiplier)`).
- **§ Depletion matcher** — verified label-only (no macro quantities consumed), so
  the multiplier does not enter; noted in the spec.

## Approach

**Wire decision: base on the wire (Option A).** The stored macro fields stay the
base in both the DB and every response; the new `portion_multiplier` field rides
alongside; every consumer computes `effective = base × multiplier`. Chosen over
"effective on the wire, base recoverable by division" because it is lossless
(no float division to recover base), storage matches wire (zero ambiguity — a
macro field always means the base), and it makes the rescale-from-base idempotency
structural (changing the multiplier never touches a macro field, so 0.5→0.75 is
always 0.75×base, never 0.375×base). Default 1 leaves every pre-existing row and
its wire shape byte-identical.

PATCH gained a third orthogonal axis alongside macro-override and note/label-edit.
All validation and conflict checks run up front (range check, empty-body check,
the manual-entry 409 for a re-queue) before any write, so a rejected PATCH never
leaves a partial change (e.g. multiplier applied but the note edit 409'd). The
multiplier lands via a dedicated `applyPortionMultiplier` store method that touches
only that column.

## Validation

- [x] `bun run build` (all packages) succeeds
- [x] `bun test` green across the repo (1382 pass / 0 fail; +12 new: 9 pipeline,
      3 route, 1 briefing-totals)
- [x] Multiplier PATCH on model / reselect / manual / estimating entries — all
      accepted, no 409, `source` unchanged, base macros unchanged
- [x] Re-PATCH rescales from base, proven numerically (0.5 then 0.75 → 0.75×base,
      asserted ≠ 0.375×base)
- [x] Default 1 leaves the entry wire byte-identical (macros untouched)
- [x] Briefing daily totals sum effective macros (SQL multiplies by
      portion_multiplier; asserted in the source unit test)
- [x] Route schema rejects non-positive / absurd multipliers with 400; pipeline
      rejects them with PatchValidationError
- [x] `bun run type-check:axi` and `bun run check:skills` unaffected
- [x] `bun install --frozen-lockfile` succeeds (no dependency changes)
- [ ] Docker image build — not verified locally (no Docker daemon); CI `docker`
      job is the first real gate. Migration is a plain additive `ALTER TABLE`.
- [ ] Live server applying migration 003 against a populated `kitchen.entries` —
      not verified locally; the column is `NOT NULL DEFAULT 1` so the backfill is
      unconditional and non-blocking.

## Risks / unknowns

- **The base-on-the-wire choice means a hypothetical pre-feature client that
  ignores `portion_multiplier` would render the base (full plate), not the
  scaled amount, for any entry the owner later scaled.** This is acceptable: a
  multiplier ≠ 1 only exists because a multiplier-aware client set it, and the
  instance runs one client version. Documented in the spec as the deliberate
  trade-off for losslessness + zero storage/wire ambiguity.

## Notes

- `portion_basis`-only PATCH remains a no-op-that-400s (unchanged from before —
  `portion_basis` is only consumed when a macro field is present). A
  `portion_basis` + `portion_multiplier` PATCH applies the multiplier and ignores
  `portion_basis`; an edge case no client sends.

## Follow-ups

- Deferred to plan (Flutter capture client repo) — the correction-sheet Portion row
  (chips ¼…2 + free entry), effective-macro rendering on tiles + day-group totals,
  and the "×½" scaled-entry marker.
