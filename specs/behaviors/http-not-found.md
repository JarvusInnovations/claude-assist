# Behavior: Unmatched-route responses (no false 200s)

## Rule

An HTTP request that matches no server route must never receive a `200`.

The host serves two things from one origin: a JSON API under `/api/**`, and a
single-page admin app whose routes are ordinary paths (`/kitchen/…`,
`/sessions/…`, …) resolved in the browser. Because those client-side routes have
no server-side counterpart, the host's not-found handler falls back to the SPA's
HTML shell. That fallback is right for exactly one case — a browser
**navigating** to a client-side route — and a lie for every other:

| Request | Response |
| --- | --- |
| `GET /api/does-not-exist` | `404` JSON |
| `DELETE /kitchen/recipes/<id>` (no server route) | `404` JSON |
| `GET /kitchen/recipes/<id>` from a client asking for JSON | `404` JSON |
| `GET /kitchen/anything` from a browser | SPA shell, `200` |

## Applies To

Every module mounted on the host, and every client of it.

The failure this rule prevents is silent. An API client that posts to a
slightly-wrong path — a dropped `/api` prefix, a verb the route never
implemented — reads `200` plus an HTML body as success. It reports the write as
done, and the write never happened. Nothing surfaces until a ledger disagrees
with reality days later.

## Details

The not-found handler resolves in order:

1. **`/api`, or any path under `/api/`** → `404` `{ error }` JSON. The prefix is
   matched as a whole path segment, so a path that merely *starts with* those
   letters (`/apiary`) is not treated as API space.
2. **Any method other than `GET`/`HEAD`** → `404` `{ error }` JSON. The shell
   answers navigations, and a navigation is a `GET`; there is no server-side
   resource at an unmatched path under any verb. `404` is the honest code here —
   `405 Method Not Allowed` would assert the path exists, which is the exact
   false claim being fixed.
3. **`GET`/`HEAD` whose `Accept` names a JSON type and no HTML type** → `404`
   `{ error }` JSON. A programmatic client that says what it wants gets an
   honest answer in that type. `*/*` alone (curl's default) does not count as
   naming JSON, and a browser's `Accept` always names HTML, so neither is
   affected.
4. **Otherwise** → the SPA shell (`index.html`, `200`). Real browser navigation
   to a client-side route is untouched; this is the only case that gets HTML.

Rules 1–3 all emit the server's standard `{ error }` envelope, so an API client
gets the same failure shape from an unmatched path as from any handled error.

## Principles

**Local:**

- **A response code is a claim about what happened.** A handler must never
  answer `200` for work it did not do. Failing loudly at a wrong path costs one
  confused caller; succeeding falsely costs data that was never written and
  nobody knows it.
