---
status: done
depends: []
specs:
  - specs/modules/pages.md
issues: []
pr: 120
---

# Plan: Pages admin tab + enriched index

## Scope

Add a read-only **Pages tab** to the admin UI that lists every published page
and its response backlog, newest activity on top — and enrich the
`GET /api/pages` index just enough to back it (`specs/modules/pages.md`
§ Index contract, § Admin surface).

In scope: the enriched `GET /api/pages` (archived filter + per-page version /
response / unprocessed counts), the store aggregate that computes them, the
admin `api/pages` client + `PagesPage`, and its sidebar nav + route wiring.

**Out of scope**: any write action from the UI (publish / archive / mark-
processed stay on the agent/CLI surface — the admin tab observes, per
`specs/modules/pages.md` § Principles); re-rendering page HTML inside the admin
(the tab links out to the public URL).

This plan also back-specs the module: `specs/modules/pages.md` documents the
existing publish/version/response/archive/serving behavior (already
implemented) alongside the two new deltas below. Only those deltas are built
here; the rest of the spec is conformance-documentation of shipped code.

## Implements

- **specs/modules/pages.md § Index contract** — `GET /api/pages` gains an
  `archived` query param (`exclude` default | `include` | `only`) and adds
  `archived_at`, `version_count`, `response_count`, `unprocessed_count` to each
  item. Existing fields and the default active-only behavior are unchanged
  (additive → no consumer breaks). Order stays `updated_at DESC`.
- **specs/modules/pages.md § Admin surface** — a `/pages` route + "Pages"
  sidebar item rendering a table (Title/slug → public URL, active/archived +
  digest status, unprocessed/total responses, version count, created/updated),
  newest-first, archived de-emphasized, `unprocessed_count > 0` badged, with an
  empty state. Read-only. Fed by one polling `GET /api/pages?archived=include`.

## Approach

- **Store** — add a single `listPages({ archived })` method (both `store.ts` and
  `memory-store.ts`, in lockstep so the interface stays honest) returning the
  enriched rows. In Postgres, compute the three counts with correlated
  aggregates (`versions` count via `current`/all versions for the slug;
  `responses` total + `FILTER (WHERE processed_at IS NULL)` for unprocessed) in
  one query, ordered `updated_at DESC`, with the `archived` param controlling
  the `archived_at IS NULL` predicate. Keep `listActive()` as the back-compat
  path or express it as `listPages({ archived: 'exclude' })` with the extra
  columns — the existing callers ignore the new fields.
- **API** — extend the existing `GET /api/pages` handler to read the `archived`
  querystring (enum, default `exclude`) and map the enriched rows to the wire
  shape in § Index contract. No new route.
- **Admin** — `api/pages.ts` client (`listPages(archived)`), a `PageSummary`
  type in `types/api.ts`, `PagesPage.tsx` following the `NotificationsPage`
  pattern (tanstack-query `refetchInterval`, shadcn `Table`, `Badge`, skeleton
  loading, empty state), a `FileText` sidebar item in `AppSidebar` near
  Captures, and the `<Route path="pages">` in `App.tsx`.

## Validation

- [x] `GET /api/pages` (no param) returns only active pages with the new count
      fields populated; the pre-existing fields are unchanged (back-compat test).
- [x] `?archived=include` returns active + archived; `?archived=only` returns
      only archived; ordering is `updated_at DESC` in every case. Invalid value → 400.
- [x] Counts are correct: a slug republished N times reports `version_count: N`;
      a page with responses reports the right `response_count` and
      `unprocessed_count`, and `unprocessed_count` drops when a response is
      marked processed.
- [x] Memory store exercised end-to-end by the route tests; pg store shares the
      `PagesStore` interface + wire mapping (SQL correctness confirmed by the
      live post-deploy probe below). *(No separate pg-fixture parity test —
      would need a live DB; deferred, covered by the deploy probe.)*
- [x] Admin: the tab lists pages newest-first, links each to its public URL,
      badges archived + digest + unprocessed-backlog, and shows the empty state
      with no pages. Read-only (no mutation controls rendered).
- [x] Full `bun run build` green (all 14 packages + admin bundle); `bun test
      packages/pages` 56 pass; admin new files typecheck clean (3 remaining tsc
      errors are pre-existing, in untouched files); `check:skills` clean (no axi
      surface change — the CLI maps only slug/title/updated/url and never sends
      `archived`).

## Risks / unknowns

- **Count-aggregate cost** — correlated aggregates over `versions` / `responses`
  per page. At the module's scale (tens of pages) this is negligible; if it ever
  isn't, the counts can move behind an opt-in `stats` param without changing the
  admin consumer. Not a concern to solve now.
- **`listActive` refactor blast radius** — the CLI (`pages-axi`) and any agent
  reading `GET /api/pages` must keep working. Mitigated by keeping the change
  additive (new fields, new opt-in param) and asserting back-compat in a test.

## Notes

- Kept `listActive()` for the public HTML index (`routes/public.ts`); only the
  JSON `GET /api/pages` handler moved to the new `listPages`. Minimal blast
  radius, no change to the human-facing `/pages` page.
- Counts use correlated subqueries (`SELECT COUNT(*) … FILTER`) rather than a
  `GROUP BY` join, so a page with zero versions/responses still returns `0`
  (no row-drop). `COUNT(*)` arrives as text/bigint from postgres.js → coerced
  with `Number()` in `rowToSummary`.
- Admin tab defaults its fetch to `archived=include` (the whole system), the
  inverse of the CLI/agent default (`exclude`) — the observability surface wants
  everything; the automation surface wants only live pages.

## Follow-ups

- The pages module itself is now specced (`specs/modules/pages.md`) but the
  admin app at large remains unspecified — the other tabs (Captures, Sessions,
  …) have no screen specs. Not this plan's scope; noted for a future admin-UI
  back-spec pass.
- If the admin ever needs to *act* on the backlog (mark responses processed,
  archive) it becomes a second write path — a deliberate decision against the
  "admin observes" principle, to be specced explicitly if wanted.
