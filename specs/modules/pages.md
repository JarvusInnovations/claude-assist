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
  full `html`, an optional `worksheet` definition (JSONB, null for an authored-HTML
  publish — see § The worksheet response pattern), and `created_at`. Republishing
  a slug inserts a new version and repoints `current_version_id`; **prior HTML
  and prior definitions are retained, never overwritten.** The definition hangs
  off the *version*, not the page, because a submission validates against the
  definition currently **served**.
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
  `?latest=1` read below), so a page can restore prior input on load. It also
  carries the shared **worksheet runtime** (`window.pagesWorksheetInit()`) — one
  implementation of the live-totals arithmetic, the submission key, and the
  submit/confirm/retry flow, so no worksheet page ships its own.

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

## The worksheet response pattern

One page shape earned promotion from convention to contract: **weighable
components with per-basis reference values, whose actual quantities a human
states, yielding a computed panel.** Kitchen prep sheets were the first
instance, but nothing about the pattern is food-specific.

Before this, each such page was hand-rolled. An agent wrote the HTML, embedded a
component table, restated every per-100-unit constant, recomputed the panel in
bespoke client-side JS, and posted a free-form `{kind, components, totals}`
payload that a *later* agent had to interpret. Three costs followed from that,
and all three are structural rather than cosmetic:

1. **Every sheet reimplemented the same arithmetic**, so every sheet could get it
   wrong differently.
2. **The payload shape was convention**, so a consumer had to guess it — and
   nothing rejected a submission that didn't match.
3. **The totals were whatever the client said they were**, with no authority
   behind them.

The worksheet pattern replaces all three: the worksheet is **published as data**,
the module renders the one canonical document from it, and the **server** computes
the totals from that same data.

This is one typed pattern, deliberately **not a form builder**. There is exactly
one shape (weighable components → named numeric totals), one renderer, and one
submit. A page that needs anything else publishes its own HTML, exactly as
before — that path is untouched.

### The worksheet definition (the request half)

`POST /api/pages` takes **either** authored `html` **or** a `worksheet`
definition — never both, never neither (`400`). A worksheet publish renders the
HTML server-side and stores the definition alongside it.

```jsonc
{
  "kind": "worksheet", "version": 1,
  "heading": "Prep — a grain bowl",       // optional; defaults to the page title
  "intro": "Weigh each component…",       // optional
  "basis": 100,                            // per-N reference basis (default 100)
  "unit": "g",                             // quantity unit (default "g")
  "fields": [                              // the totals to compute + display
    { "key": "calories", "label": "Calories", "precision": 0 },
    { "key": "protein_g", "label": "Protein", "unit": "g", "precision": 1 }
  ],
  "components": [
    { "label": "cooked grain", "quantity": 200,
      "per_basis": { "calories": 130, "protein_g": 4.5 } }
  ],
  "steps": ["Roast at 425 °F…"],           // optional instructions
  "submit_label": "Log it",                 // optional
  "cook_mode": { … }                        // optional — see § Cook mode
}
```

- `fields[].key` is an identifier (`^[a-z][a-z0-9_]*$`); keys are unique.
- `components[].label` is unique — it is the **join key** between a submission
  and the definition, so a duplicate would make a stated quantity ambiguous.
- `components[].per_basis` keys must be declared `fields` keys; an undeclared
  key is a `400`, not a silently-ignored extra.
- Validation is by hand-written validator rather than JSON Schema alone, so the
  error **names the offending path** (`components[0].per_basis.sodium_mg`) —
  a nested reference table is exactly where a generic schema failure is useless.

### The submission (the response half)

The page's client posts to the ordinary `POST /api/pages/:slug/responses`. When
the slug's **current version** carries a worksheet definition and the payload's
`kind` is `worksheet`, it is validated against that definition:

```jsonc
{ "kind": "worksheet", "version": 1,
  "submission_key": "<ULID>",              // idempotency key — see § Idempotency
  "quantities": [{ "label": "cooked grain", "quantity": 187 }],
  "note": "ran short on grain" }
```

- Unknown top-level keys are rejected — including `totals`. **A client may not
  supply totals**; the server owns the arithmetic.
- Every stated label must be a declared component, each at most once.
- An **omitted** component keeps its **planned** quantity. A submission that
  didn't mention a row left it as published; it did not drop the ingredient. This
  is the difference between an unstated value and zero, and the pattern never
  conflates them.
- A malformed submission `400`s and **appends nothing.** A payload that doesn't
  answer the published worksheet is not a response to it, and storing it would
  put an uncomputable row in the queue for someone to puzzle over later.
- A worksheet-shaped payload posted to a page with **no** definition, or a
  free-form payload posted to a worksheet page, is stored verbatim as an
  ordinary response. Worksheet handling is opt-in by publish, not by payload.

### Computed totals

For each field: **Σ over components of `quantity / basis × per_basis[field]`**,
rounded to the field's `precision`.

Null semantics match the rest of the toolkit's panel math: a component that omits
a field contributes **unknown** to it, and the field's total is `null` **only when
no component carried it**. An unknown is never coerced to `0` — "we don't know"
and "there is none of it" are different facts, and conflating them makes a total
silently understate. A component that *states* `0` contributes a real zero.

The client recomputes the same formula for the live display, but **only for
display**. The stored totals are the server's, computed from the published
definition, so a stale or tampered client cannot bend what gets recorded.

### The stored payload

The response row's `payload` is the **normalized** record — not the raw
submission:

```jsonc
{ "kind": "worksheet", "version": 1, "submission_key": "<ULID>",
  "basis": 100, "unit": "g",
  "components": [{ "label": "cooked grain", "quantity": 187,
                   "per_basis": { "calories": 130, "protein_g": 4.5 } }],
  "totals": { "calories": 363, "protein_g": 8.4 },
  "note": "ran short on grain",
  "cook_mode": { "disposition": "eaten", "label": "…", "ulid": "<ULID>" } }
```

Every quantity is resolved (omissions filled from the plan), every reference it
was computed against is carried, and the totals are present. **A consumer reads
`totals` and is done** — no recomputation, no second lookup, no guessing.

The row's `note` column defaults to a one-line summary of the totals, which is
what makes the response queue and the notify body readable at a glance; the
submitter's own remark rides in the payload's `note`.

### The rendered document

One canonical layout: a heading, the optional intro, one editable number input
per component (labelled, with its per-basis references shown), a live totals
panel, the optional steps, a notes box, one submit button, and a status region.
The definition is embedded as JSON and driven by the shared runtime in
`/pages/_helper.js` (`window.pagesWorksheetInit()`), so **the page itself carries
no arithmetic** — that is the entire point. Every rendered string is
HTML-escaped, and the embedded JSON escapes `<`, so a hostile component label
can neither inject markup nor close the script block early.

### Idempotency

A submission carries a client-generated **`submission_key`, a ULID**, stable
across retries (the runtime persists it, so a page reloaded after the network
dropped retries the *same* submission rather than opening a second one).

Responses are append-only, so the key cannot be enforced by refusing to insert —
and it shouldn't be: a resubmission genuinely happened and belongs in history.
Instead **the key is the identity of the write cook mode performs** (§ Cook
mode), and every such write is idempotent on it. So a double-submit appends a
second response row and writes **nothing** a second time.

A *deliberate* second submission — the submitter tapping "Submit again" after a
success — mints a **fresh** key, because that is a second real event. A retry
after a **failure** reuses the key, because that is one event, twice attempted.
The runtime distinguishes them; nothing else has to.

### What the submitter sees

Previously the only confirmation was a green "✓ Sent", and a POST that died
off-network failed silently. Cook mode raises the stakes — the submit now writes
to a journal — so the outcome is stated, never implied:

| state | what the submitter sees |
| --- | --- |
| submitting | button disabled, "Submitting… Do not close this page yet." |
| logged | "✓ Recorded" + exactly what was written (entry or item, by ULID) |
| already logged | "✓ Recorded — already recorded earlier; nothing was written twice" |
| write failed | "✗ Not recorded" + the server's error, a **Retry** button, and "Your numbers are still here. Retrying is safe — it cannot double-log." |
| no sink wired | "✗ Not recorded" + "The journal write did NOT happen." |

The failure panel is persistent — it never auto-clears — and the inputs are never
cleared, so the numbers survive to be retried.

**The HTTP status carries the same distinction**, so no other consumer has to
read the body to know: `201` recorded (including an idempotent replay), `502`
appended but the cook-mode write failed, `503` no sink is wired. A green check
can never appear over an unwritten log.

### Interaction with the restore affordance

Unchanged, and still honored. On load the runtime offers — never silently
applies — a restore: unsent local edits first, otherwise the last **submitted**
quantities read back through `pagesLastResponse()`. Because a resubmission
appends, that read-back is always the newest row and history is never rewritten.

## Cook mode

A worksheet may declare that **submitting it IS the log**:

```jsonc
"cook_mode": {
  "disposition": "eaten" | "packed",
  "label": "a grain bowl",
  // packed only:
  "units": 3, "shelf_life_class": "prepared",
  "recipe_ulid": "<ULID>", "sources": [{ "item_ulid": "<ULID>", "amount": 0.5 }]
}
```

Without it, a submission lands in the response queue and waits for an agent —
and *that wait is where records get lost*: a real prep sheet went unsubmitted, no
agent ran, and the meal existed nowhere until it was reconstructed from memory
days later. Cook mode closes the loop synchronously.

**Two dispositions, not two flavors of one write.** They are different acts with
different consequences, and the distinction is doctrine:

- **eaten** → one domain entry stating the computed panel verbatim.
- **packed** → one *conversion*: sources decremented, a derived item created.
  **Nothing is logged as consumption.** The batch is logged when it is eaten.

*Packing is a conversion; eating is an entry.* A packed batch is stock that will
be eaten later, possibly not as planned — pre-logging it makes the journal lie
the moment plans change. See `specs/modules/kitchen.md` § Cook mode for the
kitchen-side contracts each maps onto.

**The disposition is fixed at publish, not chosen at submit.** One submit, one
consequence — which is what lets the confirmation state exactly what happened.
The author knows at authoring time whether a sheet is a meal or a batch; a sheet
whose destiny changes is a republish (versions are retained, so that is free).

**The packed-only fields are rejected on an `eaten` sheet** rather than ignored:
an eaten meal has no derived item to give a shelf life or a unit count to, so
accepting them would silently drop them.

### The cook seam

The pages module owns no domain vocabulary. `PagesPluginConfig.worksheetCookSink`
is a `{ cook(request) → outcome }` function injected by the **server**, composed
from a domain module's decorated surface — the same pattern as every other
cross-module seam in the toolkit, so the packages never import each other. The
request carries plain strings and numbers (`ulid`, `disposition`, `label`,
`totals`, `components`, `unit`, `at?`, `note?`, `packed?`); the outcome is
`{ kind: 'entry' | 'item', ulid, created }`.

**Validating `totals` keys against a real domain panel is the sink's job**, and it
rejects an unknown key rather than dropping it — a silently-ignored field would
log a meal whose numbers quietly disagree with what the submitter watched add up
on screen, which is the exact defect cook mode exists to remove.

Absent a sink, a cook-mode submission reports `unavailable` (`503`) instead of
landing in the queue as though it had been logged.

### Order of writes, and what a mid-write failure leaves

Cook mode maps each disposition to **exactly one atomic domain write**, so there
is no "half of it landed" state to explain. The sequence is:

1. **Append the response row.** The submitted numbers become durable first.
2. **Call the sink.**
3. **On success, mark the response processed** (`processed_by` =
   `cook-mode:<kind>:<ulid>`).

Each failure point has a stated outcome:

| fails | ledger holds | submitter sees | retry |
| --- | --- | --- | --- |
| step 1 | nothing anywhere | `4xx`/`5xx`, "not recorded" | safe (nothing written) |
| step 2 | the response row, **unprocessed** | `502` + the error | safe — the sink is idempotent on the key |
| step 3 | the domain write **and** the response row, unprocessed | `201`, recorded | n/a |

Step 2's outcome is the important one: **a cook-mode failure degrades exactly to
the pre-cook-mode path.** The numbers are in the queue, the row is unprocessed —
which is the module's existing "needs attention" signal — and the notify fires at
`notice` priority (never batched to `digest`, even for a digest-opted page: a
write that did not happen is the one case a human must see). An agent can log it
from the recorded payload, or the submitter can simply retry.

Step 3 costs a duplicate *review*, never a duplicate write: the row looks
unhandled, an agent looks, and finds the key already logged.

## API surface (under `/api`)

- `POST /api/pages` — publish (`201` on create, `200` on republish). Body
  `{ slug, title, html | worksheet, digest_optin? }` — **exactly one** of `html`
  and `worksheet` (`400` for both or neither); a `worksheet` is validated
  (`400` naming the path on failure), rendered, and retained on the version.
  Returns `{ slug, title, url, version, created, worksheet, cook_mode }` where
  `worksheet` is a boolean and `cook_mode` is the declared disposition or `null`.
- `GET /api/pages` — JSON index of pages, **newest-activity first**
  (`updated_at DESC`). See § Index contract for the exact shape; this is the one
  endpoint the admin surface and any CLI/agent consume to list pages.
- `POST /api/pages/:slug/responses` — append a response (`201`); `404` for an
  unknown slug. Dispatches the notification described in § Responses. On a
  worksheet page a `kind: 'worksheet'` payload is validated + totalled
  (§ The worksheet response pattern) and, when the worksheet declares one, run
  through cook mode: `400` on a malformed submission (nothing appended), `502`
  when the row was appended but the cook-mode write failed, `503` when no sink is
  wired. The response body then also carries
  `worksheet: { totals, cook_mode }`.
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
- **The server computes what the page displays; the client's numbers are never
  authoritative.** A worksheet's totals are recomputed server-side from the
  published definition and only those are stored. A payload may state inputs; it
  may never state results. This is what turns a repeated pattern into a contract
  instead of a convention — one implementation of the arithmetic, and a consumer
  that can trust the shape it reads.
- **A page whose submit writes somewhere must say so, unambiguously, in the
  status code and on screen.** The old failure mode was a green checkmark over a
  POST that died off-network. Success, an idempotent replay, a failed write, and
  an unavailable sink are four distinct outcomes with four distinct codes and four
  distinct messages — and a retry is always safe, because the write is keyed.
- **A failed side effect degrades to the queue, never to silence.** When a
  submission's downstream write fails, the response row still lands and stays
  unprocessed — the module's existing needs-attention signal — and its
  notification escalates out of the digest tier. Losing the record is the only
  unacceptable outcome; needing a human is merely the second-best one.
