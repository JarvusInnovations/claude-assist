# Module: Pages

A generic surface for **publishing self-contained HTML pages and collecting
structured responses back from them**. A caller (an agent, a CLI, any module)
publishes an HTML document under a stable `slug`; the module serves it at a
public URL, retains every published version, and exposes an append-only
**response** channel the page's own client-side script posts to — so a page can
double as an interactive review/feedback surface, not just a static artifact.

The module is instance-agnostic: it knows nothing about *what* a page is for or
*who* reads it. It stores HTML, versions, and responses, serves the current
version, and dispatches a notification when a response arrives. What the page
contains and why is caller data and never enters this repo.

## Data model

Three tables (schema `pages`, migration `001-pages.sql`):

- **`pages.pages`** — one row per `slug` (the stable public identity). Holds
  `title`, `current_version_id` (points at the live version), `digest_optin`
  (see § Responses), `archived_at` (nullable — archive is soft), and
  `created_at` / `updated_at`.
- **`pages.versions`** — append-only. One row per publish of a slug, holding the
  full `html` and `created_at`. Republishing a slug inserts a new version and
  repoints `current_version_id`; **prior HTML is retained, never overwritten.**
- **`pages.responses`** — append-only. One row per response posted to a page,
  holding an arbitrary JSON `payload`, an optional `anchor` (a caller-defined
  location hint within the page) and `note` (human-readable summary),
  `created_at`, and the processing pair `processed_by` / `processed_at`
  (both null until handled).

A `slug` is lowercase kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), matching the
rest of the toolkit's URL-safe ids.

## Publish + versioning

`publish({ slug, title, html, digestOptin? })`:

- **New slug** → creates the page row + first version, sets it current, returns
  `created: true`.
- **Existing slug** → appends a new version, repoints `current_version_id`,
  bumps `updated_at`, and **un-archives** (`archived_at` cleared) — a republish
  is how a caller both updates and revives a page. Returns `created: false`.
- `digestOptin` applies on create; on republish it is left untouched unless
  explicitly passed. `title` always reflects the latest publish.

## Responses

A served page's client script posts responses to its own slug. Each response is
appended immutably and triggers a **notification** through the shared dispatcher
(`fastify.notify`): a page that opted into digest batching
(`digest_optin: true`) dispatches at `digest` priority, otherwise at `notice`.
The notify body is the response `note` when present, else a line derived from
the `anchor`, else a generic "new response received."

The **only** mutation allowed on a response row is marking it processed
(`markProcessed(slug, id, processedBy)` → sets `processed_by` / `processed_at`;
re-marking overwrites those two fields idempotently and never touches
`payload` / `anchor` / `note`). Responses are otherwise read-only history.

## Archive

`archive(slug)` is a **soft, idempotent** removal: it sets `archived_at`
(preserving an existing value via `COALESCE`) so the page drops out of the
active index, but **keeps all storage** — versions and responses survive, and a
later republish revives the slug. There is no hard delete.

## Serving surface (public, outside `/api`)

Registered outside the `/api` prefix (`routes/public.ts`):

- `GET /pages` — the human-facing HTML index of active pages.
- `GET /pages/:slug` — serves the slug's current version HTML (with the module's
  CSP), plus the injected helper script below.
- `GET /pages/_helper.js` — a small client script served to every page. It
  exposes helpers a page uses to post responses to its own slug and to discover
  its own last submission (`window.pagesLastResponse()`, backed by the
  `?latest=1` read below), so a page can restore prior input on load.

### Encoding: every served body declares `charset=utf-8`

Stored HTML is UTF-8 and is served byte-for-byte, so **every response from this
surface carries an explicit charset**: `text/html; charset=utf-8` for the page
and the index, `application/javascript; charset=utf-8` for the helper,
`text/plain; charset=utf-8` for the not-found body.

A `text/*` response without the parameter leaves decoding to the browser's
locale default, which mangles every multibyte glyph (`→ ✓ × ≈ ° é —`). An
authored page could self-declare `<meta charset="utf-8">`, and pages did — but
that makes correct rendering something each caller has to remember, and a page
that forgets renders garbled with no error anywhere. **The module owns the
default.** This is not cosmetic where a page carries instructions: a corrupted
degree sign in a cooking temperature is a wrong number, not a wrong-looking
one — which is why the worksheet pattern below depends on it.

## API surface (under `/api`)

- `POST /api/pages` — publish (`201` on create, `200` on republish). Body
  `{ slug, title, html, digest_optin? }`; returns `{ slug, title, url, version,
  created }`.
- `GET /api/pages` — JSON index of pages, **newest-activity first**
  (`updated_at DESC`). See § Index contract for the exact shape; this is the one
  endpoint the admin surface and any CLI/agent consume to list pages.
- `POST /api/pages/:slug/responses` — append a response (`201`); `404` for an
  unknown slug. Dispatches the notification described in § Responses.
- `GET /api/pages/:slug/responses` — read-back queue for a slug. Filters:
  `since` (ISO), `unprocessed=true`, `latest=1` (single newest, same wrapper
  shape). `404` for an unknown slug.
- `POST /api/pages/:slug/responses/:id/processed` — mark one response handled
  (`processed_by` required). `404` for an unknown response.
- `POST /api/pages/:slug/archive` — soft-archive (idempotent). `404` for an
  unknown slug.

### Index contract (`GET /api/pages`)

The list endpoint returns, per page, the fields needed to see a page **and its
status** at a glance — identity, activity, and the response backlog — without a
second call.

**Query**

- `archived` — `exclude` (default) | `include` | `only`. Default returns only
  active pages, preserving the historical active-only contract; agents/CLIs that
  never pass the param see no behavior change.

**Response** — `{ pages: [...], count }`, `pages` ordered `updated_at DESC`.
Each item carries:

| field | type | meaning |
| --- | --- | --- |
| `slug` | string | stable public id |
| `title` | string | current title |
| `url` | string | absolute public page URL |
| `digest_optin` | boolean | response notifications batch at digest tier |
| `archived_at` | string \| null | soft-archive timestamp (null = active) |
| `version_count` | integer | retained versions (publish count) |
| `response_count` | integer | total responses ever posted |
| `unprocessed_count` | integer | responses with `processed_at IS NULL` |
| `created_at` | string | first publish |
| `updated_at` | string | latest publish/activity |

The count fields are additive: pre-existing consumers that read only
`slug`/`title`/`url` are unaffected. `unprocessed_count` is the page's live
"needs attention" signal (a page with responses no one has marked handled).

## Admin surface (Pages tab)

A read-only **Pages tab** in the admin UI (`apps/admin`), giving a
system-of-record view of every published page and its response backlog in one
place — the observational counterpart to the agent/CLI write surface above.

**Route + nav** — `/pages` in the admin app, with a "Pages" item in the sidebar
navigation (placed among the content surfaces, near Captures).

**Data** — a single `GET /api/pages?archived=include` (so archived pages are
visible, not hidden), consumed with the app's standard polling query (auto-
refetch on the same cadence as the other live boards). No other endpoint is
needed; the enriched index above carries everything the table shows.

**Display** — one row per page, in the order the index returns them (**newest
activity on top**, `updated_at DESC`), each showing:

- **Title**, with the `slug` beneath it; the row links out to the page's public
  `url` (opens in a new tab) — the tab is a launcher into the real pages, not a
  re-render of their HTML.
- **Status** — an `active` / `archived` badge (archived rows visually
  de-emphasized), plus a `digest` badge when `digest_optin` is set.
- **Responses** — `unprocessed_count` / `response_count`; a page with
  `unprocessed_count > 0` is badged to stand out (the backlog is the whole
  reason to look at this tab), a page with zero responses reads muted.
- **Versions** — `version_count`.
- **Created** and **Updated** timestamps.

**Empty state** — a clear "no pages published yet" message when the index is
empty.

**Scope** — read-only. Publishing, archiving, and marking responses processed
stay on the agent/CLI surface (see § Principles: *the admin UI observes*). The
tab surfaces the backlog; acting on it happens where the acting already lives.

## Principles

**Local**

- **History is append-only; nothing is rewritten or hard-deleted.** A republish
  adds a version (prior HTML kept); a response is immutable but for its
  processed marker; archive is a soft flag that keeps all storage. The module
  never destroys what a page was or what came back from it — auditability beats
  reclaiming rows.
- **The admin UI observes; it does not become a second write path.** Pages are
  published, archived, and triaged by agents and the CLI — the surfaces that
  already carry the context to do it well. The admin tab is a read-only window
  onto that system of record, so there is exactly one write path to reason
  about, not a UI that silently diverges from it. New observational columns are
  welcome; new mutation buttons are a deliberate scope decision, not a default.
- **A page's status is its response backlog.** Among everything a row could
  show, the load-bearing signal is "did something come back, and has anyone
  handled it?" — `unprocessed_count` leads the status design; version churn and
  timestamps are context around it.
