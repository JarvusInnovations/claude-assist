/**
 * Unmatched-route resolution (specs/behaviors/http-not-found.md).
 *
 * The host serves a JSON API under `/api/**` and an admin SPA whose routes are
 * ordinary paths resolved in the browser (`/kitchen/…`, `/sessions/…`). Those
 * client-side routes have no server-side counterpart, so the not-found handler
 * falls back to the SPA's HTML shell — correct for a browser NAVIGATING to one,
 * a lie for everything else. A `DELETE /kitchen/recipes/<id>` answering `200`
 * with an HTML body tells an API client a write succeeded that never happened.
 *
 * Pure so it can be unit-tested without booting the server (server.ts is an
 * entrypoint script, not a factory).
 */

export type NotFoundOutcome = 'json-404' | 'spa-shell';

export interface UnmatchedRequest {
  method: string;
  /** Request URL or path — a query string and/or origin may be present. */
  url: string;
  /** Raw `Accept` header, if the client sent one. */
  accept?: string | undefined;
}

/** Methods a browser navigation can use — the only ones the SPA shell answers. */
const NAVIGATION_METHODS = new Set(['GET', 'HEAD']);

/** Path (no query, no origin), always leading-slashed. */
function pathOf(url: string): string {
  const noQuery = url.split(/[?#]/, 1)[0] ?? '';
  // Absolute-form request targets (proxies, HTTP/2) — keep only the path.
  const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(noQuery)
    ? (noQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '') || '/')
    : noQuery;
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * True for `/api` and anything under `/api/` — matched as a whole path segment,
 * so `/apiary` is NOT API space (the previous `startsWith('/api')` check
 * swallowed it).
 */
export function isApiPath(url: string): boolean {
  const path = pathOf(url);
  return path === '/api' || path.startsWith('/api/');
}

/**
 * True when the client named a JSON media type and no HTML one. A wildcard-only
 * Accept (curl's default) does not count as naming JSON, and a browser's Accept
 * always names HTML — so neither is diverted away from the shell.
 */
export function prefersJson(accept: string | undefined): boolean {
  if (!accept) return false;
  const types = accept
    .split(',')
    .map((part) => part.split(';', 1)[0]!.trim().toLowerCase())
    .filter(Boolean);
  const html = types.some((t) => t === 'text/html' || t === 'application/xhtml+xml' || t === 'text/*');
  const json = types.some((t) => t === 'application/json' || t.endsWith('+json'));
  return json && !html;
}

/**
 * Decide what an unmatched request gets. Order is the spec's:
 *   1. API space            → json-404
 *   2. non-navigation verb  → json-404 (404, not 405: nothing exists at this
 *                             path under ANY verb, and 405 would assert it does)
 *   3. JSON-preferring GET  → json-404
 *   4. otherwise            → the SPA shell, so client-side routing still works
 */
export function resolveUnmatched(request: UnmatchedRequest): NotFoundOutcome {
  if (isApiPath(request.url)) return 'json-404';
  if (!NAVIGATION_METHODS.has(request.method.toUpperCase())) return 'json-404';
  if (prefersJson(request.accept)) return 'json-404';
  return 'spa-shell';
}
