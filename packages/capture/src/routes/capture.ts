/**
 * Capture routes
 *
 * POST /capture              - dumb-fast idempotent ingest (the whole point)
 * GET  /capture              - list captures (status filter; review surfaces)
 * GET  /capture/:ulid        - single capture
 * POST /capture/:ulid/correct - human routing correction (re-classifies + re-routes)
 *
 * Registered under the server's /api prefix → /api/capture.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { CaptureInput, CaptureStatus, CaptureType } from '../types.js';
import { CAPTURE_SOURCES, CAPTURE_TYPES } from '../types.js';
import { ULID_PATTERN } from '../ulid.js';
import { InvalidTransitionError } from '../state.js';
import type { CapturePipeline } from '../services/pipeline.js';
import type { ReferenceStore } from '../store.js';
import type { AttachmentStorage } from '../services/attachments/storage.js';
import { buildObjectKey } from '../services/attachments/storage.js';
import {
  AttachmentKeyMismatchError,
  AttachmentStorageUnconfiguredError,
  AttachmentVerificationError,
} from '../services/attachments/errors.js';

export interface CaptureRoutesConfig {
  pipeline: CapturePipeline;
  referenceStore: ReferenceStore;
  /** Object store for attachments; null when the feature is unconfigured. */
  storage?: AttachmentStorage | null;
}

/** Map an attachment-ingest error to its HTTP status, or null if not one. */
function attachmentErrorStatus(err: unknown): number | null {
  if (
    err instanceof AttachmentStorageUnconfiguredError ||
    err instanceof AttachmentVerificationError ||
    err instanceof AttachmentKeyMismatchError
  ) {
    return err.statusCode;
  }
  return null;
}

const CAPTURE_BODY_SCHEMA = {
  type: 'object',
  required: ['ulid', 'text', 'source'],
  additionalProperties: false,
  properties: {
    ulid: { type: 'string', pattern: ULID_PATTERN.source },
    source: { type: 'string', enum: [...CAPTURE_SOURCES] },
    text: { type: 'string', minLength: 1, maxLength: 100_000 },
    type: { type: 'string', maxLength: 100 },
    urls: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string', pattern: '^https?://', maxLength: 2048 },
    },
    tags: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string', minLength: 1, maxLength: 100 },
    },
    payload: { type: 'object' },
    attachments: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['object_key', 'filename', 'content_type', 'bytes'],
        additionalProperties: false,
        properties: {
          object_key: { type: 'string', minLength: 1, maxLength: 1024 },
          filename: { type: 'string', minLength: 1, maxLength: 512 },
          content_type: { type: 'string', minLength: 1, maxLength: 256 },
          bytes: { type: 'integer', minimum: 0 },
        },
      },
    },
    captured_at: { type: 'string', format: 'date-time' },
  },
} as const;

const SIGN_BODY_SCHEMA = {
  type: 'object',
  required: ['ulid', 'filename', 'content_type', 'bytes'],
  additionalProperties: false,
  properties: {
    ulid: { type: 'string', pattern: ULID_PATTERN.source },
    filename: { type: 'string', minLength: 1, maxLength: 512 },
    content_type: { type: 'string', minLength: 1, maxLength: 256 },
    bytes: { type: 'integer', minimum: 0, maximum: 1024 * 1024 * 1024 },
    /** Attachment ordinal within the capture; distinct per attachment. */
    index: { type: 'integer', minimum: 0, maximum: 999, default: 0 },
  },
} as const;

interface SignBody {
  ulid: string;
  filename: string;
  content_type: string;
  bytes: number;
  index?: number;
}

export const registerCaptureRoutes: FastifyPluginAsync<CaptureRoutesConfig> = async (
  fastify,
  { pipeline, referenceStore, storage = null }
) => {
  // POST /capture - store immediately, ack fast. No classification, no
  // routing, no model calls in this handler — ever. The one synchronous check
  // is attachment verification (objects must exist in the bucket), which
  // surfaces as a clear 4xx/503 rather than a silently-broken row.
  fastify.post<{ Body: CaptureInput }>(
    '/capture',
    { schema: { body: CAPTURE_BODY_SCHEMA } },
    async (request, reply) => {
      let ingested;
      try {
        ingested = await pipeline.ingest(request.body);
      } catch (err) {
        const status = attachmentErrorStatus(err);
        if (status !== null) {
          reply.status(status);
          return { error: (err as Error).message };
        }
        throw err;
      }
      const { record, created } = ingested;
      reply.status(created ? 201 : 200);
      return {
        ulid: record.ulid,
        status: record.status,
        created,
        received_at: record.received_at,
      };
    }
  );

  // POST /capture/attachments/sign - issue a short-lived V4 signed upload URL.
  // The client PUTs the bytes directly to the bucket, then references the
  // returned object_key in the capture POST. Static path; matched ahead of
  // /capture/:ulid. 503 when the feature is unconfigured.
  fastify.post<{ Body: SignBody }>(
    '/capture/attachments/sign',
    { schema: { body: SIGN_BODY_SCHEMA } },
    async (request, reply) => {
      if (!storage) {
        reply.status(503);
        return { error: 'Attachment storage is not configured' };
      }
      const { ulid, filename, content_type, bytes, index = 0 } = request.body;
      const object_key = buildObjectKey(ulid, index, filename);
      const url = await storage.signUpload({ object_key, content_type, bytes });
      return { url, object_key };
    }
  );

  // GET /capture - list (review dashboard, digests)
  fastify.get<{
    Querystring: { status?: CaptureStatus; limit?: string; offset?: string };
  }>(
    '/capture',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: {
              type: 'string',
              enum: ['queued', 'classified', 'awaiting_executor', 'awaiting_review', 'routed', 'resolved'],
            },
            limit: { type: 'string', pattern: '^[0-9]+$' },
            offset: { type: 'string', pattern: '^[0-9]+$' },
          },
        },
      },
    },
    async (request) => {
      const { status } = request.query;
      const limit = parseInt(request.query.limit ?? '50', 10);
      const offset = parseInt(request.query.offset ?? '0', 10);
      const captures = await pipeline.list({ status, limit, offset });
      return { captures, count: captures.length };
    }
  );

  // GET /capture/references - stored link references (routed link_reference
  // captures land here). Static path; find-my-way matches it ahead of :ulid.
  fastify.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/capture/references',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'string', pattern: '^[0-9]+$' },
            offset: { type: 'string', pattern: '^[0-9]+$' },
          },
        },
      },
    },
    async (request) => {
      const limit = parseInt(request.query.limit ?? '50', 10);
      const offset = parseInt(request.query.offset ?? '0', 10);
      const references = await referenceStore.list({ limit, offset });
      return { references, count: references.length };
    }
  );

  // GET /capture/:ulid/attachments - attachment metadata plus a freshly
  // signed READ url for each object. Static-ahead-of-param ordering keeps
  // /capture/references and /capture/attachments/sign unaffected. 503 when the
  // feature is unconfigured. Registered before /capture/:ulid so the
  // two-segment param route doesn't shadow it.
  fastify.get<{ Params: { ulid: string } }>(
    '/capture/:ulid/attachments',
    async (request, reply) => {
      const capture = await pipeline.get(request.params.ulid);
      if (!capture) {
        reply.status(404);
        return { error: 'Capture not found' };
      }
      if (capture.attachments.length === 0) {
        return { attachments: [], count: 0 };
      }
      if (!storage) {
        reply.status(503);
        return { error: 'Attachment storage is not configured' };
      }
      const attachments = await Promise.all(
        capture.attachments.map(async (a) => ({
          ...a,
          url: await storage.signRead(a.object_key),
        }))
      );
      return { attachments, count: attachments.length };
    }
  );

  // GET /capture/:ulid
  fastify.get<{ Params: { ulid: string } }>('/capture/:ulid', async (request, reply) => {
    const capture = await pipeline.get(request.params.ulid);
    if (!capture) {
      reply.status(404);
      return { error: 'Capture not found' };
    }
    return capture;
  });

  // POST /capture/:ulid/correct - the owner overrides the classified type; the
  // capture re-routes to the corrected destination immediately. Corrections
  // are recorded (classifier: 'correction') as tuning signal.
  fastify.post<{ Params: { ulid: string }; Body: { type: CaptureType } }>(
    '/capture/:ulid/correct',
    {
      schema: {
        body: {
          type: 'object',
          required: ['type'],
          additionalProperties: false,
          properties: {
            type: { type: 'string', enum: [...CAPTURE_TYPES] },
          },
        },
      },
    },
    async (request, reply) => {
      const capture = await pipeline.get(request.params.ulid);
      if (!capture) {
        reply.status(404);
        return { error: 'Capture not found' };
      }
      if (capture.status === 'queued') {
        reply.status(409);
        return { error: 'Capture not yet classified - nothing to correct' };
      }
      const updated = await pipeline.correct(request.params.ulid, request.body.type);
      return updated;
    }
  );

  fastify.post<{ Params: { ulid: string }; Body: { resolution?: string } }>(
    '/capture/:ulid/resolve',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            resolution: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const updated = await pipeline.resolve(
          request.params.ulid,
          request.body?.resolution ?? null
        );
        if (!updated) {
          reply.status(404);
          return { error: 'Capture not found' };
        }
        return updated;
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          reply.status(409);
          return { error: err.message };
        }
        throw err;
      }
    }
  );
};
