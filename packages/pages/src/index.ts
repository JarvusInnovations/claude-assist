/**
 * Pages module — publish self-contained interactive HTML to a stable URL and
 * collect structured responses against it, asynchronously.
 *
 * Provides:
 * - The API surface (POST /api/pages, .../responses, .../archive) registered
 *   by the default plugin below.
 * - The public serving surface (GET /pages, GET /pages/:slug, GET
 *   /pages/_helper.js), exported separately as `registerPagesPublicRoutes`
 *   since it must be registered OUTSIDE the /api prefix (see routes/public.ts).
 * - On a new response: dispatch through `fastify.notify` (when present) at
 *   notice priority, or the digest tier when the page opted in.
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import {
  createPlugin,
  type PluginOptions,
  type Scheduler,
  type NotifyDispatcher,
  type PagePublisher,
  type PagesPluginConfig,
} from '@jarvus/claude-assist-core';
import { PgPagesStore } from './store.js';
import { createPagePublisher } from './publisher.js';
import { registerPagesApiRoutes } from './routes/api.js';

// Module augmentation for fastify decorators
declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
    notify?: NotifyDispatcher;
    pages?: PagePublisher;
  }
}

export default createPlugin('pages', async (fastify: FastifyInstance, options: PluginOptions) => {
  const config: PagesPluginConfig = options.pagesConfig ?? {};

  const store = new PgPagesStore(fastify.sql);

  await fastify.register(registerPagesApiRoutes, {
    store,
    baseUrl: config.baseUrl,
    // Cook-mode seam (§ Cook mode): composed by the server from the kitchen
    // module's decorated surface. Absent → cook-mode submissions 503 rather
    // than landing in the queue as if they had been logged.
    worksheetCookSink: config.worksheetCookSink,
  });

  // Server-side publish surface, for pipelines that render a page on a
  // schedule and have no request to derive a base URL from.
  fastify.decorate('pages', createPagePublisher(store, config.baseUrl));

  fastify.log.info(
    { cookMode: config.worksheetCookSink ? 'wired' : 'unavailable' },
    'Pages module loaded (publish/collect API)'
  );
});

// Re-exports for the server app + tests.
export {
  registerPagesPublicRoutes,
  PAGE_CONTENT_TYPE,
  HELPER_CONTENT_TYPE,
  type PagesPublicRoutesConfig,
} from './routes/public.js';
export {
  registerPagesApiRoutes,
  formatResponseNotifyBody,
  cookModeProcessedBy,
  type PagesApiRoutesConfig,
  type CookModeReport,
  type CookModeStatus,
} from './routes/api.js';
export { PgPagesStore, type PagesStore } from './store.js';
export { createPagePublisher } from './publisher.js';
export { MemoryPagesStore } from './memory-store.js';
export { HELPER_SCRIPT } from './helper-script.js';
export { PAGE_CSP } from './csp.js';
export * from './worksheet.js';
export { resolveBaseUrl, pageUrl } from './url.js';
export * from './types.js';
