---
status: done
depends: []
specs:
  - specs/modules/kitchen.md
issues: []
pr: 122
---

# Plan: Source-less conversions + prep-recording guidance

## Scope

Make `POST /inventory/convert` accept **zero sources** — the "I prepped this
from a recipe, raw inputs not tracked" case — and teach the `assist-kitchen`
skill to record prepped food as a `convert` (recipe-linked), never a plain
`inventory add`. Closes the live-usage gap where a hand-built overnight-oats jar
was `add`ed as an ordinary item and could never reach the consume shelf
(`specs/modules/kitchen.md` § Conversions).

In scope: the convert relaxation (route schema + `convert()` + `ConvertInput`
type + the `kitchen-axi inventory convert` CLI), a source-less route test, and
the SKILL.md guidance (a decisive rule + an "I made a batch" workflow).

**Out of scope**: an app "I prepped this" action (a capture-app surface, its
own plan); attaching provenance to an already-existing plain item (re-mint via
a source-less convert instead — that's exactly what the jar migration does).

## Implements

- **specs/modules/kitchen.md § Conversions (§ Source-less conversions)** —
  `sources` is optional: `[]`/omitted creates the derived item with empty
  provenance, decrementing nothing, while still honoring `derived.recipe_ulid`
  (the consume-eligibility hook). Route `CONVERT_BODY_SCHEMA` drops `sources`
  from `required` and sets `minItems: 0`; `convert()` drops the empty-sources
  throw and iterates `input.sources ?? []`; the CLI's `convert` no longer
  requires `--from`. `derived.name` is still required (400 without it).
- **Prep-recording guidance** — the skill now carries a decisive rule ("prepped
  food is a `convert`, never a plain `inventory add`") and an "I made a batch of
  X" workflow, so a fresh agent records prepped food the way that reaches the
  shelf. The generated command reference for `inventory convert` says the same.

## Approach

- Relaxation is additive: every existing sourced convert still behaves
  identically (same decrement, same 400/409 cases); only the "no sources" path
  is newly allowed. `ConvertInput.sources` becomes optional.
- Guidance lives in the hand-written SKILL.md sections (Decisive rules + Common
  workflows) plus the `reference.ts` entry that feeds the generated command
  list; `bun run build:skills` regenerates both artifacts.
- An instance's vendored copy is a separate manual sync step (the instance's
  `.agents/skills/assist-kitchen/` was stale — see Follow-ups); this plan ships
  the source of truth.

## Validation

- [x] Source-less convert (`sources` omitted or `[]`) → `201`, creates a
      recipe-linked derived item, empty provenance, nothing decremented; missing
      `derived.name` still 400 (route test).
- [x] Every existing sourced-convert test still passes (438 kitchen tests green).
- [x] `bun run build:skills` + `check:skills` clean; `inventory convert` help
      and generated reference describe optional `--from` + the shelf-eligibility
      rule.
- [x] Full `bun run build` green; PR CI green; deployed; live source-less
      convert against Postgres mints a consume-eligible item (the jar test).

## Risks / unknowns

- **Agents ignoring the guidance** — mitigated by putting it in *both* the
  decisive-rules section (read before writing) and the generated command
  summary, and by the CLI help itself. The behavior is also self-correcting: an
  item added the wrong way simply won't appear on the shelf.

## Notes

- **Live jar test (the closing acceptance test).** Through the *synced instance
  CLI* (proving a fresh agent's path): pushed a 7-component "Overnight oats —
  full build" recipe (computes to 492 kcal / 27 g protein / 1.9 g sat — faithful
  to the actual jar; the pre-existing banked recipe computed only ~357, which
  would have under-counted intake by ~150 kcal), then `inventory convert` with
  **no `--from`** minted a recipe-linked "Overnight-oats jar #3", and finished
  the old plain-`add`ed jar. A throwaway consume proved the live resolver:
  `inventory consume` logged exactly **492.1 / 27.1 / 1.9** (`source: reselect`,
  no model call) and depleted the item atomically — deleted afterward to keep
  totals clean. The real jar is left `stocked` + eligible for a one-tap morning
  log.

## Follow-ups

- **Skill-sync drift** — an instance's vendored `assist-kitchen` skill lagged the
  claude-assist build by a day (convert/consume shipped but never synced), which
  is what hid the feature from the agent. The sync is manual; worth a
  check/automation so the instance can't silently run a stale CLI.
- **App "I prepped this" action** — a capture-app surface over this endpoint so
  prep can be logged from the phone, not only the CLI. Separate plan.
- **No "prepared dish" shelf-life class** — the jar minted with
  `shelf_life_class: fridge_short` → `eat_by` 14 days out, but a prepared oat jar
  is best within 3-4 days (its own notes say so). The taxonomy has no short
  "prepared/leftovers" class, so a derived dish's `eat_by` overstates its life
  and sinks it in eat-first ordering. Worth a `prepared`/`leftovers` class (or a
  convert-time `eat_by`/shelf-life-days override for derived items).
- **Meal-bank oat-jar accuracy** — the banked "Overnight oats" recipe (~357 kcal)
  understates the owner's actual jars. Reconcile the bank against the
  full-build recipe pushed here. Doctrine/bank concern, not this module.
