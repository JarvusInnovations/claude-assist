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
import { PgPagesStore } from '../store.js';
import { PAGE_CSP } from '../csp.js';
import { HELPER_SCRIPT } from '../helper-script.js';

declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
  }
}

export interface PagesPublicRoutesConfig {
  /** Override for the base URL used to build absolute links on the index page. */
  baseUrl?: string;
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
  _options
) => {
  const store = new PgPagesStore(fastify.sql);

  // GET /pages - index of active pages, newest-first.
  fastify.get('/pages', async (_request, reply) => {
    const pages = await store.listActive();
    reply.header('Content-Security-Policy', PAGE_CSP);
    reply.type('text/html');
    return renderIndex(pages.map((p) => ({ slug: p.slug, title: p.title, updatedAt: p.updatedAt })));
  });

  // GET /pages/_helper.js - the response-helper script. Static path; find-my-way
  // matches it ahead of the :slug route below.
  fastify.get('/pages/_helper.js', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    reply.type('application/javascript');
    return HELPER_SCRIPT;
  });

  // GET /pages/:slug - serve the current version's HTML, unmodified.
  fastify.get<{ Params: { slug: string } }>('/pages/:slug', async (request, reply) => {
    const { slug } = request.params;
    const current = await store.getCurrent(slug);
    if (!current) {
      reply.status(404).type('text/plain');
      return 'Page not found';
    }

    reply.header('Content-Security-Policy', PAGE_CSP);
    reply.type('text/html');
    return current.html;
  });
};
