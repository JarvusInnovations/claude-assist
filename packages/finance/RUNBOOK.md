# Finance module runbook

The finance module mirrors a personal transaction ledger, renders a **monthly**
review as a page plus a Tana link, pings once when the review is ready, and
offers categorize/annotate proposals a human can accept and — separately —
apply.

Two things it deliberately does not do: it does not run daily, and it does not
edit anyone's ledger on its own.

---

## 1. Which source to run

The module reaches a provider one of two ways. Choose with `FINANCE_SOURCE_MODE`.

### `api` — speak the provider's own API

Consumer finance apps generally have a web/mobile API with no public contract.
It works, it is fast, and it can change on any Tuesday. The module is built for
that: the GraphQL documents live in one file (`src/source/documents.ts`), every
response is read through accessors that raise `schema_drift` rather than
returning an empty list, and **the batch probes before it pulls**. When the
shape moves, you get one `blocked` review that says so — never a review that
confidently reports a month of no spending.

```
FINANCE_SOURCE_MODE=api
FINANCE_API_BASE_URL=https://api.your-provider.example
FINANCE_API_EMAIL=you@example.com
FINANCE_API_PASSWORD=…
FINANCE_API_TOTP_SECRET=…      # base32, if the account has MFA
```

There is no default base URL. Point it at the host the provider's own web app
talks to; you can read that off the network tab in a browser.

If you would rather not store a password, mint a session token by hand and set
`FINANCE_API_TOKEN` instead. With it set, the host never sends credentials at
all — it only ever presents the token.

**Auth shape.** `POST {base}/auth/login/` with a JSON body of
`{username, password, trusted_device, supports_mfa, totp?}`, returning
`{"token": "…"}`; subsequent calls send `Authorization: Token <token>` and
`Client-Platform: web` to `POST {base}/graphql`. The token is cached in
`finance.provider_session` so a monthly pull does not re-trip MFA. A 401 clears
the row and logs in once more; a second 401 is reported as `unauthenticated`
and the batch exits clean.

**When the API drifts.** Symptom: `GET /api/finance/source` returns
`{"ok": false, "reason": "schema_drift"}`, or a review lands `blocked` with a
GraphQL "cannot query field" detail. Fix in order:

1. Open the provider's web app with the network tab recording and capture the
   request its own transaction list makes.
2. Adjust the matching document in `src/source/documents.ts` and, if a field
   moved, its accessor in `src/source/api-source.ts`.
3. `GET /api/finance/source` to confirm, then re-run the period:
   `POST /api/finance/reviews/run {"period":"2026-07"}`.

If step 1 shows the API has moved somewhere this module cannot follow — a signed
request, a device attestation, a client-side crypto challenge — stop. Switch to
`command` mode rather than building a browser emulator inside this package.

### `command` — an exporter you supply

The fallback contract. You supply an argv array; the module speaks JSON to it
over stdin/stdout and knows nothing else about how it gets the data. This is the
seam for a headless Chrome session on a VM that stays logged in — which is a
real thing to operate, and belongs where you can watch it fail rather than
buried in a library.

```
FINANCE_SOURCE_MODE=command
FINANCE_SOURCE_CMD=["/opt/finance-export/bin/export", "--profile", "personal"]
FINANCE_SOURCE_CMD_TIMEOUT_MS=180000
```

**Request** (one JSON object on stdin):

```json
{"op": "preflight"}
{"op": "transactions", "startDate": "2026-07-01", "endDate": "2026-07-31", "limit": 2000}
{"op": "accounts"}
{"op": "categories"}
{"op": "update", "update": {"id": "txn-123", "categoryId": "cat-9", "notes": "…"}}
```

**Response** (one JSON object on stdout, **exit 0 either way**):

```json
{"ok": true, "data": [ … ]}
{"ok": false, "reason": "unauthenticated", "detail": "browser session expired"}
```

`reason` is one of `not_configured`, `unauthenticated`, `unavailable`,
`schema_drift`. A non-zero exit or unparseable stdout is treated as
`unavailable` — the exporter itself is broken, which is a different problem from
the session being logged out, and the two must stay distinguishable.

Row shapes `data` must carry:

| op | fields |
| --- | --- |
| `transactions` | `id`, `date` (`YYYY-MM-DD`), `amount` (signed number, negative = outflow), and optionally `currency`, `merchant`, `description`, `accountId`, `categoryId`, `categoryName`, `notes`, `tags[]`, `pending`, `needsReview` |
| `accounts` | `id`, `name`, optionally `type`, `institution`, `balance` |
| `categories` | `id`, `name`, optionally `group` |
| `update` | `data` is ignored; `ok: true` means the write landed |

`preflight` should be cheap and should actually verify the session — a
`preflight` that always says yes defeats the exit-clean design.

**Standing up a headless session.** The shape that works: a long-lived VM the
owner can reach over VNC, a Chrome profile logged into the provider by hand, and
a small script driving that profile (Playwright/Puppeteer against the persistent
user-data dir) to read the transaction list and print the envelope above. Keep
the browser attached to a real display session; expect to re-authenticate by
hand every few weeks, and let the coverage heartbeat below be what tells you.

---

## 2. Verify without waiting a month

```bash
# Is the source reachable at all?
curl -s localhost:2529/api/finance/source | jq

# Run a specific closed month end to end.
curl -s -XPOST localhost:2529/api/finance/reviews/run \
  -H 'content-type: application/json' -d '{"period":"2026-07"}' | jq

# What did it produce?
curl -s localhost:2529/api/finance/reviews/2026-07 | jq '.review'
```

A healthy run returns `status: "rendered"` and a `pageUrl`. A run that returns
`status: "blocked"` with a `blockedReason` did the right thing: the source was
not usable, nothing was fabricated, no ping was sent, and **the heartbeat was
not advanced** — so if it stays blocked, the coverage monitor pages.

The scheduled task is `finance:monthly-review`; trigger it the normal way with
`POST /api/scheduler/tasks/finance:monthly-review` (which takes the same
advisory lock a scheduled run does).

---

## 3. Coverage and staleness

The module registers `finance-review` with the coverage ledger at plugin load —
before any successful run, so an instance that has *never* produced a review is
itself the alert. `FINANCE_COVERAGE_THRESHOLD` defaults to `40 days`: a month
plus slack, so a batch that runs a few days late is quiet and a skipped month
pages.

`beat()` fires only on a run that rendered something. Blocked and failed runs
deliberately leave the heartbeat where it was.

```bash
curl -s localhost:2529/api/notify/heartbeats | jq '.[] | select(.name=="finance-review")'
```

---

## 4. The assist, and what "apply" means

The assist reads the rows the deterministic composer flagged and proposes a
category (from the account's own category list — never free text) and/or a short
note. Proposals land in `finance.suggestions` as `proposed`.

- **Accept/Reject on the page** records a decision. It does not touch the
  ledger. This is why one-tap accept is safe.
- **Applying** is a separate call:
  `POST /api/finance/reviews/:id/apply`, optionally with
  `{"suggestionIds": [12, 15]}`. It applies only `accepted` rows, reports every
  row it skipped and why, and never rolls back one write because another failed.

If the assist is off (`FINANCE_DISABLE_ASSIST`, or no model invoker), the review
still renders — with the flagged rows and no proposals attached.

---

## 5. Failure modes worth recognizing

| Symptom | Meaning | Action |
| --- | --- | --- |
| `blocked` / `not_configured` | An env var is missing | Check `FINANCE_API_BASE_URL` (or `FINANCE_SOURCE_CMD`) |
| `blocked` / `unauthenticated` | Password changed, MFA rotated, or the browser session expired | Re-auth; for `api` mode also `DELETE FROM finance.provider_session` |
| `blocked` / `schema_drift` | The provider moved its API | Section 1, "When the API drifts" |
| `rendered` but no `pageUrl` | The pages module is not loaded | Enable `ENABLE_PAGES` |
| `pageUrl` is a bare path | `PAGES_BASE_URL` is unset | Set it; the module refuses to guess a host |
| Review renders, no Tana link | `FINANCE_TANA_WORKSPACE_ID`/`TANA_MCP_TOKEN` unset | Optional — set them if you want the day-node pointer |
| Review renders, no proposals | Assist disabled, or the invoker has no key or is over budget | Check `/api/invoker/spend` |

---

## 6. The boundary

This module is personal-domain. It holds the owner's own credentials, and its
only external write is to the owner's own ledger, from an explicit human action.
It must not grow a path into any shared or team system of record — not a
notification into a team channel, not a summary into a shared doc, not a
"helpful" cross-post. If a future feature seems to want one, the answer is that
a human reads the review and decides what, if anything, to say elsewhere.
