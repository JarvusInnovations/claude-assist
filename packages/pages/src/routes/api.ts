/**
 * Pages API routes — registered under the server's /api prefix → /api/pages/*.
 *
 *   POST /pages                            - publish (republish = new version)
 *   POST /pages/:slug/responses            - append-only response ingest
 *   GET  /pages/:slug/responses             - read-back queue (since/unprocessed)
 *   POST /pages/:slug/responses/:id/processed - mark one response handled
 *   POST /pages/:slug/archive               - remove from index, keep storage
 *
 * The public serving surface (GET /pages, GET /pages/:slug, GET
 * /pages/_helper.js) lives in routes/public.ts and is registered outside the
 * /api prefix.
 */

import type { FastifyPluginAsync } from 'fastify';
import { SLUG_PATTERN } from '../types.js';
import type { PagesStore } from '../store.js';
import { pageUrl } from '../url.js';

export interface PagesApiRoutesConfig {
  store: PagesStore;
  /** Override for links in publish responses + notify dispatch (see url.ts). */
  baseUrl?: string;
}

const PUBLISH_BODY_SCHEMA = {
  type: 'object',
  required: ['slug', 'title', 'html'],
  additionalProperties: false,
  properties: {
    slug: { type: 'string', pattern: SLUG_PATTERN.source, minLength: 1, maxLength: 200 },
    title: { type: 'string', minLength: 1, maxLength: 500 },
    html: { type: 'string', minLength: 1, maxLength: 5_000_000 },
    digest_optin: { type: 'boolean' },
  },
} as const;

const RESPONSE_BODY_SCHEMA = {
  type: 'object',
  required: ['payload'],
  additionalProperties: false,
  properties: {
    payload: {},
    anchor: { type: 'string', maxLength: 500 },
    note: { type: 'string', maxLength: 10_000 },
  },
} as const;

const PROCESSED_BODY_SCHEMA = {
  type: 'object',
  required: ['processed_by'],
  additionalProperties: false,
  properties: {
    processed_by: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

/** Notify body text for a new response — the note if given, else a generic line. */
export function formatResponseNotifyBody(note?: string | null, anchor?: string | null): string {
  if (note && note.trim().length > 0) return note.trim();
  if (anchor && anchor.trim().length > 0) return `New response anchored to "${anchor.trim()}".`;
  return 'New response received.';
}

export const registerPagesApiRoutes: FastifyPluginAsync<PagesApiRoutesConfig> = async (
  fastify,
  { store, baseUrl }
) => {
  // POST /pages - publish. Republishing an existing slug adds a new version
  // (prior HTML retained) and repoints current_version_id; also un-archives.
  fastify.post<{
    Body: { slug: string; title: string; html: string; digest_optin?: boolean };
  }>('/pages', { schema: { body: PUBLISH_BODY_SCHEMA } }, async (request, reply) => {
    const { slug, title, html, digest_optin } = request.body;
    const { page, version, created } = await store.publish({
      slug,
      title,
      html,
      digestOptin: digest_optin,
    });

    reply.status(created ? 201 : 200);
    return {
      slug: page.slug,
      title: page.title,
      url: pageUrl(request, page.slug, baseUrl),
      version: version.id,
      created,
    };
  });

  // POST /pages/:slug/responses - append-only. Dispatches a notify at notice
  // priority (or the digest tier when the page opted in).
  fastify.post<{
    Params: { slug: string };
    Body: { payload: unknown; anchor?: string; note?: string };
  }>(
    '/pages/:slug/responses',
    { schema: { body: RESPONSE_BODY_SCHEMA } },
    async (request, reply) => {
      const { slug } = request.params;
      const result = await store.addResponse(slug, {
        payload: request.body.payload,
        anchor: request.body.anchor ?? null,
        note: request.body.note ?? null,
      });
      if (!result) {
        reply.status(404);
        return { error: `Page not found: ${slug}` };
      }

      const { page, response } = result;
      await fastify.notify?.notify({
        priority: page.digestOptin ? 'digest' : 'notice',
        title: page.title,
        body: formatResponseNotifyBody(response.note, response.anchor),
        url: pageUrl(request, page.slug, baseUrl),
      });

      reply.status(201);
      return {
        id: response.id,
        payload: response.payload,
        anchor: response.anchor,
        note: response.note,
        created_at: response.createdAt,
      };
    }
  );

  // GET /pages/:slug/responses - read-back queue for any session/agent.
  fastify.get<{
    Params: { slug: string };
    Querystring: { since?: string; unprocessed?: string };
  }>(
    '/pages/:slug/responses',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            since: { type: 'string', format: 'date-time' },
            unprocessed: { type: 'string', enum: ['true', 'false'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { slug } = request.params;
      const { since, unprocessed } = request.query;
      const responses = await store.listResponses(slug, {
        since: since ? new Date(since) : undefined,
        unprocessedOnly: unprocessed === 'true',
      });
      if (responses === null) {
        reply.status(404);
        return { error: `Page not found: ${slug}` };
      }
      return {
        responses: responses.map((r) => ({
          id: r.id,
          payload: r.payload,
          anchor: r.anchor,
          note: r.note,
          created_at: r.createdAt,
          processed_by: r.processedBy,
          processed_at: r.processedAt,
        })),
        count: responses.length,
      };
    }
  );

  // POST /pages/:slug/responses/:id/processed - mark handled. The one
  // mutation allowed on a response row; re-marking simply overwrites
  // processed_by/processed_at (idempotent, never touches payload/anchor/note).
  fastify.post<{ Params: { slug: string; id: string }; Body: { processed_by: string } }>(
    '/pages/:slug/responses/:id/processed',
    { schema: { body: PROCESSED_BODY_SCHEMA } },
    async (request, reply) => {
      const { slug, id } = request.params;
      const responseId = Number.parseInt(id, 10);
      if (!Number.isInteger(responseId)) {
        reply.status(400);
        return { error: 'id must be an integer' };
      }

      const updated = await store.markProcessed(slug, responseId, request.body.processed_by);
      if (!updated) {
        reply.status(404);
        return { error: `Response not found: ${slug}/${id}` };
      }
      return {
        id: updated.id,
        processed_by: updated.processedBy,
        processed_at: updated.processedAt,
      };
    }
  );

  // POST /pages/:slug/archive - idempotent; removes from the index, keeps storage.
  fastify.post<{ Params: { slug: string } }>('/pages/:slug/archive', async (request, reply) => {
    const { slug } = request.params;
    const page = await store.archive(slug);
    if (!page) {
      reply.status(404);
      return { error: `Page not found: ${slug}` };
    }
    return { slug: page.slug, archived_at: page.archivedAt };
  });
};
