/**
 * Content-Security-Policy for served pages.
 *
 * Pages are self-contained HTML documents — same portability rule as lavish
 * artifacts (no external CDN dependencies; inline `<script>`/`<style>` is the
 * expected authoring style). The policy below allows same-origin + inline
 * script/style (so an artifact's own inline code runs, and so it can load the
 * response helper via `<script src="/pages/_helper.js">`), allows same-origin
 * fetch/XHR (the response helper posts back to `/api/pages/:slug/responses`),
 * and otherwise locks the document down: no external network, no framing.
 */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
