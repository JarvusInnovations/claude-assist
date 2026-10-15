---
status: planned
depends: []
specs:
  - specs/modules/kitchen.md
issues: []
---

# Plan: Day coverage — mark the gaps so metrics stop reading them as fasts

## Scope

Per-day rollups derive from entries alone, so a collection outage and a genuine
low-intake day produce identical rows. A multi-day outage therefore enters every
weekly average, trend, and net-energy line as a run of extreme deficits that
never happened.

- `kitchen.day_coverage` — sparse table, one row per deviating owner-local day:
  `day` (PK), `coverage` (`partial` | `none`), `reason` (required),
  `asserted_at`, `asserted_by`. **No row means `complete`.**
- `days` rows gain `coverage` and `coverage_reason`. Totals are still reported
  in full — the rollup never hides what was logged.
- `kitchen-axi days mark <date> [--through <date>] --coverage partial|none
  --reason "<text>"` (idempotent upsert) and `days unmark <date>`.
- Multi-day aggregations exclude non-`complete` days **and state how many they
  dropped**.
- An open question when a day looks suspicious (zero entries, or an expenditure
  against no intake) — a prompt, never an assertion.

**Out of scope**: any UI. Coverage is asserted in conversation by an agent
reconstructing a period, not entered on a form. Also out of scope: per-entry
*day-placement* confidence — a reconstructed entry whose totals are exact but
whose day is a guess is a third state, adjacent to this and not blocked by it.
See § Follow-ups.

## Implements

- **specs/modules/kitchen.md § Day coverage** — the whole section, including its
  local principle.

## Approach

**The table is sparse and that is the load-bearing choice.** Absence means
`complete`, so the common case writes nothing and the schema can never drift
into "every day needs a coverage decision." It also means the migration is
additive with no backfill: every existing day stays `complete` because no row
exists for it.

**`reason` is `NOT NULL` at the database level, not just in the CLI.** A bare
flag decays into an unreadable marker within a month, and the reason is the only
thing that lets a later reader decide whether an exclusion still stands. Enforce
it where it cannot be bypassed.

**The hard constraint is that nothing may infer coverage.** This is the part
most likely to be "helpfully" violated by a later change: a heuristic that flags
implausibly-low days looks like an obvious improvement and is the exact bug the
section exists to prevent. A genuine skipped-meals day is a *finding* — often
the most useful row in a week — and any rule confident enough to catch the
outage is confident enough to erase it. Detection surfaces a **question** in the
existing open-questions channel and stops there.

**Consumers split on read, not on write.** The rollup reports `coverage`
alongside real totals; each consumer decides. Averaging surfaces drop
non-`complete` days from the denominator and say so; single-day surfaces render
the flag and reason. Pushing policy to the consumer keeps the module honest —
it never lies about what was logged, and it never silently decides what a
number means.

**Auditing the consumers is most of the work, not the table.** The migration and
the two CLI verbs are small. The real surface is every place that already
aggregates across days — the weekly panel, the net line, the briefing's daily
totals, the trend view — each of which currently assumes every day in its window
is real. Each needs the exclusion *and* the statement of what it dropped.

## Validation

- [ ] Migration applies cleanly; every pre-existing day reads `complete` with no
      backfill.
- [ ] `days mark` is idempotent — marking the same day twice leaves one row and
      updates the reason.
- [ ] `days mark --through` marks an inclusive range in one call.
- [ ] `days unmark` restores `complete` (row deleted, not flagged).
- [ ] A `reason`-less mark is rejected by the database, not only by the CLI.
- [ ] `days` output carries `coverage` on every row and the real totals on
      `partial` rows.
- [ ] A multi-day aggregation over a window containing a `none` day excludes it
      from the denominator **and** reports the exclusion count.
- [ ] A day with an expenditure and no entries raises an open question, and that
      question does not resolve itself.
- [ ] No code path writes `day_coverage` without an explicit caller-supplied
      coverage value — verified by grep, not by inspection.

## Risks / unknowns

- **The exclusion rule is only as good as its audit.** A consumer missed in the
  sweep keeps averaging over gaps and looks correct. Enumerate the aggregating
  surfaces from the spec's "applies to the whole module surface" list rather
  than from memory.
- **`partial` is a floor, and a floor is easy to quote as a total.** Any surface
  citing a `partial` day's numbers has to say so, which is a presentation
  discipline the schema cannot enforce.
- **Open questions already exist as a channel**; adding a second kind that is
  answered by a different verb may want a type discriminator. Check the existing
  shape before adding to it.
