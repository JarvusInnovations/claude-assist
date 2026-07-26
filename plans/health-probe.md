---
status: planned
depends: []
specs:
  - specs/modules/kitchen.md
issues: [121]
pr:
---

# Plan: Health Connect probe — server side (phase 3a scaffolding)

## Scope

The storage + read surface for the Health Connect discovery probe, per
`specs/modules/kitchen.md` § Health Connect probe. A raw-document intake:
`POST /kitchen/health-probe` (idempotent on ulid, jsonb payload, bounded
size), `GET /kitchen/health-probes` (metadata + per-type counts +
permission summary), `GET /kitchen/health-probes/:ulid` (full document),
and `kitchen-axi health-probes list|show`.

Explicitly scaffolding: no rollup participation, no dedup, no
interpretation — records stored verbatim as the app posted them. The
phase-3 weigh_ins/dedup spec gets written against what these dumps show,
and this surface is expected to shrink or be superseded then.

Out of scope: the app-side probe (hari-capture, its own plan), any
weigh_ins table, any expenditure wiring.

## Implements

- **§ Health Connect probe** — capture contract, list/show reads, CLI.

## Approach

- Migration: `kitchen.health_probes` (ulid PK, captured_at, window_since,
  window_until, permissions jsonb, records jsonb, created_at). All jsonb
  writes via `sql.json(x as never)` — never a `::jsonb` cast (established
  no-op footgun).
- Routes follow the expenditure-routes register pattern; payload cap
  enforced at the route (reject oversize with 413, clear message).
- Per-type counts computed at read time from the raw records (no derived
  columns to maintain on scaffolding).
- Tests: idempotent replay, verbatim round-trip of an arbitrary record
  blob, permission map ride-along, size cap, list counts. Synthetic data
  only (public repo).

## Validation

- [ ] POST → GET round-trips an arbitrary nested record document
      byte-faithfully (jsonb object, not a double-encoded string).
- [ ] Same-ulid replay returns the original (no duplicate row).
- [ ] Oversize payload rejected with a clear 413.
- [ ] List shows per-type counts + granted/denied summary without loading
      full payloads.
- [ ] CLI `health-probes list|show` render both reads.
- [ ] Nothing in summary/rollup/net paths reads probe data (grep-level
      check).

## Risks / unknowns

- Payload bound (a few MB) vs 30 days of high-frequency HR/sleep records —
  the app trims the window rather than splitting; if real dumps hit the cap
  constantly, phase 3 proper picks a streaming/windowed shape informed by
  exactly that observation.

## Notes

_(at closeout)_

## Follow-ups

_(at closeout)_
