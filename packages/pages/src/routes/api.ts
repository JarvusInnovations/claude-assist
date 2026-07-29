/**
 * Pages API routes — registered under the server's /api prefix → /api/pages/*.
 *
 *   POST /pages                            - publish (republish = new version)
 *   GET  /pages                             - JSON index of active pages (newest-first)
 *   POST /pages/:slug/responses            - append-only response ingest
 *   GET  /pages/:slug/responses             - read-back queue (since/unprocessed/latest)
 *   POST /pages/:slug/responses/:id/processed - mark one response handled
 *   POST /pages/:slug/archive               - remove from index, keep storage
 *
 * The public serving surface (GET /pages, GET /pages/:slug, GET
 * /pages/_helper.js) lives in routes/public.ts and is registered outside the
 * /api prefix.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { WorksheetCookRequest, WorksheetCookSink } from '@jarvus/claude-assist-core';
import { SLUG_PATTERN } from '../types.js';
import type { PagesStore } from '../store.js';
import { pageUrl } from '../url.js';
import {
  WorksheetValidationError,
  isWorksheetPayload,
  normalizeWorksheetResponse,
  renderWorksheetHtml,
  summarizeWorksheet,
  validateWorksheetDefinition,
  validateWorksheetSubmission,
  type WorksheetDefinition,
  type WorksheetResponsePayload,
} from '../worksheet.js';

export interface PagesApiRoutesConfig {
  store: PagesStore;
  /** Override for links in publish responses + notify dispatch (see url.ts). */
  baseUrl?: string;
  /** Cook-mode sink (§ Cook mode); absent → cook-mode submissions 503. */
  worksheetCookSink?: WorksheetCookSink;
}

const PUBLISH_BODY_SCHEMA = {
  type: 'object',
  required: ['slug', 'title'],
  additionalProperties: false,
  properties: {
    slug: { type: 'string', pattern: SLUG_PATTERN.source, minLength: 1, maxLength: 200 },
    title: { type: 'string', minLength: 1, maxLength: 500 },
    html: { type: 'string', minLength: 1, maxLength: 5_000_000 },
    // Shape-checked by validateWorksheetDefinition, which names the offending
    // path in its message — far more useful than a generic JSON-schema failure
    // on a nested per-component reference table.
    worksheet: { type: 'object' },
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

/**
 * Cook-mode result as reported to the submitter (§ What the submitter sees).
 *
 * - `logged` — the write happened on this submission.
 * - `already-logged` — an idempotent replay; the row already existed, nothing
 *   was written twice.
 * - `failed` — the response is recorded but the domain write did NOT happen.
 * - `unavailable` — no sink is wired, so nothing could be written.
 */
export type CookModeStatus = 'logged' | 'already-logged' | 'failed' | 'unavailable';

export interface CookModeReport {
  disposition: string;
  status: CookModeStatus;
  kind: 'entry' | 'item' | null;
  ulid: string;
  created: boolean;
  error: string | null;
}

/** The marker written into `processed_by` once cook mode closes the loop. */
export function cookModeProcessedBy(outcome: { kind: string; ulid: string }): string {
  return `cook-mode:${outcome.kind}:${outcome.ulid}`;
}

/** Build the sink request from a validated worksheet + its normalized payload. */
function toCookRequest(
  definition: WorksheetDefinition,
  payload: WorksheetResponsePayload
): WorksheetCookRequest {
  const directive = definition.cook_mode!;
  const request: WorksheetCookRequest = {
    ulid: payload.submission_key,
    disposition: directive.disposition,
    label: directive.label,
    totals: payload.totals,
    components: payload.components.map((c) => ({ label: c.label, quantity: c.quantity })),
    unit: payload.unit,
  };
  if (payload.note) request.note = payload.note;
  if (directive.disposition === 'packed') {
    request.packed = {};
    if (directive.units !== undefined) request.packed.units = directive.units;
    if (directive.shelf_life_class !== undefined) {
      request.packed.shelf_life_class = directive.shelf_life_class;
    }
    if (directive.recipe_ulid !== undefined) request.packed.recipe_ulid = directive.recipe_ulid;
    if (directive.sources !== undefined) request.packed.sources = directive.sources;
  }
  return request;
}

export const registerPagesApiRoutes: FastifyPluginAsync<PagesApiRoutesConfig> = async (
  fastify,
  { store, baseUrl, worksheetCookSink }
) => {
  // POST /pages - publish. Republishing an existing slug adds a new version
  // (prior HTML retained) and repoints current_version_id; also un-archives.
  // Body carries EITHER authored `html` or a `worksheet` definition the module
  // renders (§ The worksheet response pattern) — never both.
  fastify.post<{
    Body: {
      slug: string;
      title: string;
      html?: string;
      worksheet?: unknown;
      digest_optin?: boolean;
    };
  }>('/pages', { schema: { body: PUBLISH_BODY_SCHEMA } }, async (request, reply) => {
    const { slug, title, html, worksheet, digest_optin } = request.body;

    if ((html === undefined) === (worksheet === undefined)) {
      reply.status(400);
      return { error: 'exactly one of html or worksheet is required' };
    }

    let definition: WorksheetDefinition | null = null;
    let renderedHtml = html ?? '';
    if (worksheet !== undefined) {
      try {
        definition = validateWorksheetDefinition(worksheet);
      } catch (err) {
        if (err instanceof WorksheetValidationError) {
          reply.status(400);
          return { error: err.message };
        }
        throw err;
      }
      renderedHtml = renderWorksheetHtml(definition, title);
    }

    const { page, version, created } = await store.publish({
      slug,
      title,
      html: renderedHtml,
      digestOptin: digest_optin,
      worksheet: definition,
    });

    reply.status(created ? 201 : 200);
    return {
      slug: page.slug,
      title: page.title,
      url: pageUrl(request, page.slug, baseUrl),
      version: version.id,
      created,
      worksheet: definition !== null,
      cook_mode: definition?.cook_mode?.disposition ?? null,
    };
  });

  // GET /pages - JSON index, newest-activity-first (for agents/CLI + the admin
  // Pages tab; the human HTML index is the public GET /pages route outside
  // /api). `archived` selects the set (default `exclude` = active only, the
  // historical contract); each item carries aggregate status counts.
  fastify.get<{ Querystring: { archived?: 'exclude' | 'include' | 'only' } }>(
    '/pages',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            archived: { type: 'string', enum: ['exclude', 'include', 'only'] },
          },
        },
      },
    },
    async (request) => {
      const pages = await store.listPages({ archived: request.query.archived ?? 'exclude' });
      return {
        pages: pages.map((p) => ({
          slug: p.slug,
          title: p.title,
          url: pageUrl(request, p.slug, baseUrl),
          digest_optin: p.digestOptin,
          archived_at: p.archivedAt,
          version_count: p.versionCount,
          response_count: p.responseCount,
          unprocessed_count: p.unprocessedCount,
          created_at: p.createdAt,
          updated_at: p.updatedAt,
        })),
        count: pages.length,
      };
    }
  );

  // POST /pages/:slug/responses - append-only. Dispatches a notify at notice
  // priority (or the digest tier when the page opted in).
  //
  // When the slug's CURRENT version was published as a worksheet, a
  // `kind: 'worksheet'` payload is validated against that definition, its
  // totals are recomputed server-side, and — if the worksheet declares a
  // cook mode — handed to the cook sink. See § The worksheet response pattern.
  fastify.post<{
    Params: { slug: string };
    Body: { payload: unknown; anchor?: string; note?: string };
  }>(
    '/pages/:slug/responses',
    { schema: { body: RESPONSE_BODY_SCHEMA } },
    async (request, reply) => {
      const { slug } = request.params;

      const current = await store.getCurrent(slug);
      const definition = current?.worksheet ?? null;
      const isWorksheetSubmission = definition !== null && isWorksheetPayload(request.body.payload);

      let payload: unknown = request.body.payload;
      let note = request.body.note ?? null;
      let worksheetPayload: WorksheetResponsePayload | null = null;

      if (isWorksheetSubmission) {
        try {
          const submission = validateWorksheetSubmission(request.body.payload, definition);
          worksheetPayload = normalizeWorksheetResponse(definition, submission);
        } catch (err) {
          // Nothing is appended: a payload that doesn't answer the published
          // worksheet is not a response to it, and storing it would put an
          // uncomputable row in the queue for someone to puzzle over later.
          if (err instanceof WorksheetValidationError) {
            reply.status(400);
            return { error: err.message };
          }
          throw err;
        }
        payload = worksheetPayload;
        note = note ?? summarizeWorksheet(definition, worksheetPayload);
      }

      // The response row is appended FIRST, before any cook-mode write. If the
      // write then fails, the submitted numbers are already durable and the row
      // sits UNPROCESSED — which is exactly the pre-cook-mode signal that an
      // agent needs to look at this. Nothing is ever silently lost.
      const result = await store.addResponse(slug, {
        payload,
        anchor: request.body.anchor ?? null,
        note,
      });
      if (!result) {
        reply.status(404);
        return { error: `Page not found: ${slug}` };
      }
      const { page, response } = result;

      let cookReport: CookModeReport | null = null;
      if (worksheetPayload && definition?.cook_mode) {
        const directive = definition.cook_mode;
        if (!worksheetCookSink) {
          cookReport = {
            disposition: directive.disposition,
            status: 'unavailable',
            kind: null,
            ulid: worksheetPayload.submission_key,
            created: false,
            error: 'no cook-mode sink is configured on this instance',
          };
        } else {
          try {
            const outcome = await worksheetCookSink.cook(
              toCookRequest(definition, worksheetPayload)
            );
            cookReport = {
              disposition: directive.disposition,
              status: outcome.created ? 'logged' : 'already-logged',
              kind: outcome.kind,
              ulid: outcome.ulid,
              created: outcome.created,
              error: null,
            };
            // Cook mode closed the loop, so the response is born handled — it
            // never enters the backlog an agent is expected to work through.
            await store
              .markProcessed(slug, response.id, cookModeProcessedBy(outcome))
              .catch((error: unknown) => {
                // The write landed; only the bookkeeping didn't. Leaving the row
                // unprocessed costs a duplicate REVIEW, never a duplicate write
                // (the ULID makes the retry idempotent).
                fastify.log.error(
                  { error, slug, responseId: response.id },
                  'Cook mode wrote successfully but marking the response processed failed'
                );
              });
          } catch (error) {
            cookReport = {
              disposition: directive.disposition,
              status: 'failed',
              kind: null,
              ulid: worksheetPayload.submission_key,
              created: false,
              error: error instanceof Error ? error.message : String(error),
            };
            fastify.log.error({ error, slug }, 'Cook mode write failed');
          }
        }
      }

      const failed = cookReport !== null && cookReport.status !== 'logged' && cookReport.status !== 'already-logged';
      await fastify.notify?.notify({
        // A cook-mode write that did NOT happen is never digest material — it is
        // the one case where the human has to act.
        priority: failed ? 'notice' : page.digestOptin ? 'digest' : 'notice',
        title: page.title,
        body: failed
          ? `Worksheet submitted but NOT recorded (${cookReport!.status}): ${cookReport!.error ?? 'unknown error'}`
          : formatResponseNotifyBody(response.note, response.anchor),
        url: pageUrl(request, page.slug, baseUrl),
      });

      // A cook-mode failure is not a success with a footnote: the status code
      // says so, so a green checkmark can never appear over an unwritten log.
      // 502 = the downstream write failed; 503 = this instance can't write at all.
      reply.status(
        cookReport?.status === 'failed' ? 502 : cookReport?.status === 'unavailable' ? 503 : 201
      );
      return {
        id: response.id,
        payload: response.payload,
        anchor: response.anchor,
        note: response.note,
        created_at: response.createdAt,
        ...(worksheetPayload
          ? {
              worksheet: {
                totals: worksheetPayload.totals,
                cook_mode: cookReport,
              },
            }
          : {}),
        ...(failed ? { error: cookReport!.error } : {}),
      };
    }
  );

  // GET /pages/:slug/responses - read-back queue for any session/agent.
  // `?latest=1` short-circuits since/unprocessed and returns just the single
  // newest response (still wrapped in `responses`, 0 or 1 items — same shape
  // as the unfiltered list, so callers don't need a second response format).
  // This backs `window.pagesLastResponse()` in the served helper script,
  // which pages use to discover + restore their own last submission on load.
  fastify.get<{
    Params: { slug: string };
    Querystring: { since?: string; unprocessed?: string; latest?: string };
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
            latest: { type: 'string', enum: ['1', 'true'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { slug } = request.params;
      const { since, unprocessed, latest } = request.query;
      const latestOnly = latest === '1' || latest === 'true';
      const responses = await store.listResponses(slug, {
        since: since ? new Date(since) : undefined,
        unprocessedOnly: unprocessed === 'true',
        latestOnly,
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
