/**
 * Public serving surface for published pages. Registered OUTSIDE the /api
 * prefix (bare on the root Fastify instance, like the sessions module's
 * registerPublicShareRoutes) since these are documents to open in a browser,
 * not JSON endpoints.
 *
 *   GET /pages               - index of active pages, newest-first
 *   GET /pages/:slug          - serve the current version's HTML
 *   GET /pages/_helper.js     - the response-helper script pages embed
 *
 * The helper exposes `window.pagesRespond(payload, { anchor, note })` to
 * submit and `window.pagesLastResponse()` to read back the most recent
 * submission (or `null`). Convention: pages that collect submissions SHOULD
 * call `pagesLastResponse()` on load and offer a restore affordance built
 * from the result, so a reload doesn't lose the visitor's last answer.
 *
 * Same auth posture as the rest of claude-assist: Tailscale-reachable only,
 * no public exposure, no bypass of the reverse proxy's basic-auth gate (that
 * bypass is reserved for /share/*, which is meant for recipients outside the
 * Tailnet). Pages may embed instance data freely.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type postgres from 'postgres';
import { PgPagesStore, type PagesStore } from '../store.js';
import { PAGE_CSP } from '../csp.js';
import { HELPER_SCRIPT } from '../helper-script.js';

declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
  }
}

/**
 * Content types served here, each carrying an EXPLICIT `charset=utf-8`.
 *
 * Pages are stored and served as UTF-8 byte-for-byte, but a `text/*` response
 * with no charset parameter leaves the encoding to the browser's locale
 * default — which mangles every multibyte glyph (`→ ✓ × ≈ °F é —`). Authored
 * pages could self-declare `<meta charset>`, but a page that forgets it renders
 * garbled, and the module (not each caller) owns the default. This matters
 * beyond cosmetics for worksheets: a corrupted degree sign in a cooking
 * instruction is a real defect.
 */
export const PAGE_CONTENT_TYPE = 'text/html; charset=utf-8';
export const HELPER_CONTENT_TYPE = 'application/javascript; charset=utf-8';
const PLAIN_CONTENT_TYPE = 'text/plain; charset=utf-8';

export interface PagesPublicRoutesConfig {
  /** Override for the base URL used to build absolute links on the index page. */
  baseUrl?: string;
  /**
   * Store override. Defaults to a `PgPagesStore` over `fastify.sql` — injected
   * only by tests, which exercise the serving surface without Postgres.
   */
  store?: PagesStore;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderIndex(pages: { slug: string; title: string; updatedAt: Date }[]): string {
  const items = pages
    .map(
      (p) => `      <li>
        <a href="/pages/${encodeURIComponent(p.slug)}">${escapeHtml(p.title)}</a>
        <time datetime="${p.updatedAt.toISOString()}">${p.updatedAt.toISOString()}</time>
      </li>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Pages</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  li { margin-bottom: 0.75rem; }
  time { display: block; font-size: 0.8rem; color: #666; }
</style>
</head>
<body>
  <h1>Pages</h1>
  <ul>
${items || '      <li>No active pages.</li>'}
  </ul>
</body>
</html>
`;
}

export const registerPagesPublicRoutes: FastifyPluginAsync<PagesPublicRoutesConfig> = async (
  fastify: FastifyInstance,
  options
) => {
  const store: PagesStore = options.store ?? new PgPagesStore(fastify.sql);

  // GET /pages - index of active pages, newest-first.
  fastify.get('/pages', async (_request, reply) => {
    const pages = await store.listActive();
    reply.header('Content-Security-Policy', PAGE_CSP);
    reply.type(PAGE_CONTENT_TYPE);
    return renderIndex(pages.map((p) => ({ slug: p.slug, title: p.title, updatedAt: p.updatedAt })));
  });

  // GET /pages/_helper.js - the response-helper script. Static path; find-my-way
  // matches it ahead of the :slug route below.
  fastify.get('/pages/_helper.js', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    reply.type(HELPER_CONTENT_TYPE);
    return HELPER_SCRIPT;
  });

  // GET /pages/:slug - serve the current version's HTML, unmodified (but with
  // an explicit UTF-8 charset on the response — see PAGE_CONTENT_TYPE).
  fastify.get<{ Params: { slug: string } }>('/pages/:slug', async (request, reply) => {
    const { slug } = request.params;
    const current = await store.getCurrent(slug);
    if (!current) {
      reply.status(404).type(PLAIN_CONTENT_TYPE);
      return 'Page not found';
    }

    reply.header('Content-Security-Policy', PAGE_CSP);
    reply.type(PAGE_CONTENT_TYPE);
    return current.html;
  });
};
