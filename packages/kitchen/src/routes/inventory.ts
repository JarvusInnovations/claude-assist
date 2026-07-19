/**
 * Kitchen inventory routes — registered under /api/kitchen.
 *
 * Receipts:
 *   POST   /kitchen/receipts               - multipart: `receipt` meta part + photo parts
 *   GET    /kitchen/receipts               - list batches
 *   GET    /kitchen/receipts/:ulid         - batch + parsed lines
 * Inventory:
 *   GET    /kitchen/inventory              - on-hand items, eat-by order
 *   GET    /kitchen/inventory/questions    - open needs-info questions
 *   GET    /kitchen/inventory/:ulid        - single item
 *   POST   /kitchen/inventory              - create an item (manual / seed)
 *   POST   /kitchen/inventory/events       - free-text event resolver
 *   POST   /kitchen/inventory/:ulid/events - explicit opened|finished|tossed
 *   POST   /kitchen/inventory/:ulid/label  - multipart: label photo(s) → resolve needs-info
 * Products & lexicon (agentic seed + reads):
 *   POST   /kitchen/products               GET /kitchen/products
 *   POST   /kitchen/lexicon                GET /kitchen/lexicon
 *
 * Photos never touch disk (@fastify/multipart toBuffer holds them in memory
 * for the request only).
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { ULID_PATTERN } from '../ulid.js';
import { InvalidTransitionError } from '../inventory-state.js';
import { LabelParserUnavailableError, type InventoryPipeline } from '../services/inventory.js';
import {
  INVENTORY_EVENT_TYPES,
  INVENTORY_STATES,
  SHELF_LIFE_CLASSES,
  type InventoryEventType,
  type InventoryPhotoPart,
  type InventoryState,
  type ShelfLifeClass,
} from '../inventory-types.js';

export interface InventoryRoutesConfig {
  inventory: InventoryPipeline;
  maxPhotoBytes?: number;
  maxPhotos?: number;
}

/** Collect photo parts + a named JSON meta part (field or file), memory-only. */
async function collectMultipart(
  request: FastifyRequest,
  metaField: string
): Promise<{ meta: unknown; photos: InventoryPhotoPart[]; error?: string }> {
  let meta: unknown;
  const photos: InventoryPhotoPart[] = [];
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      if (part.fieldname === 'photo' || part.fieldname === 'photos') {
        photos.push({ data: buffer, mimeType: part.mimetype });
      } else if (part.fieldname === metaField) {
        try {
          meta = JSON.parse(buffer.toString('utf8'));
        } catch {
          return { meta: undefined, photos, error: `${metaField} field must be valid JSON` };
        }
      }
      // Unknown file fields are drained (toBuffer consumed them) and ignored.
    } else if (part.fieldname === metaField) {
      try {
        meta = JSON.parse(part.value as string);
      } catch {
        return { meta: undefined, photos, error: `${metaField} field must be valid JSON` };
      }
    }
  }
  return { meta, photos };
}

export const registerInventoryRoutes: FastifyPluginAsync<InventoryRoutesConfig> = async (
  fastify,
  { inventory, maxPhotoBytes = 10 * 1024 * 1024, maxPhotos = 6 }
) => {
  await fastify.register(multipart, {
    limits: { fileSize: maxPhotoBytes, files: maxPhotos, fields: 4 },
  });

  // ── Receipts ────────────────────────────────────────────────────────────────

  fastify.post('/kitchen/receipts', async (request, reply) => {
    if (!request.isMultipart()) {
      reply.status(400);
      return { error: 'multipart/form-data required (receipt JSON part + optional photo parts)' };
    }
    let collected;
    try {
      collected = await collectMultipart(request, 'receipt');
    } catch (err) {
      reply.status(400);
      return { error: `multipart parse failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (collected.error) {
      reply.status(400);
      return { error: collected.error };
    }
    const meta = collected.meta;
    if (!meta || typeof meta !== 'object') {
      reply.status(400);
      return { error: 'missing receipt field (multipart part named "receipt")' };
    }
    const obj = meta as Record<string, unknown>;
    if (typeof obj.ulid !== 'string' || !ULID_PATTERN.test(obj.ulid)) {
      reply.status(400);
      return { error: 'receipt.ulid is required and must be a valid ULID' };
    }
    if (obj.store !== undefined && typeof obj.store !== 'string') {
      reply.status(400);
      return { error: 'receipt.store must be a string' };
    }
    if (obj.purchased_at !== undefined && typeof obj.purchased_at !== 'string') {
      reply.status(400);
      return { error: 'receipt.purchased_at must be an ISO date string' };
    }

    const { batch, created } = await inventory.ingestReceipt(
      {
        ulid: obj.ulid,
        store: obj.store as string | undefined,
        purchased_at: obj.purchased_at as string | undefined,
      },
      collected.photos
    );
    reply.status(created ? 201 : 200);
    return batch;
  });

  fastify.get<{ Querystring: { limit?: string } }>(
    '/kitchen/receipts',
    { schema: { querystring: limitQuery } },
    async (request) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      const batches = await inventory.listBatchViews(limit);
      return { batches, count: batches.length };
    }
  );

  fastify.get<{ Params: { ulid: string } }>('/kitchen/receipts/:ulid', async (request, reply) => {
    const result = await inventory.getBatchView(request.params.ulid);
    if (!result) {
      reply.status(404);
      return { error: 'Purchase batch not found' };
    }
    return result;
  });

  // ── Inventory reads ───────────────────────────────────────────────────────────

  fastify.get<{ Querystring: { state?: string; limit?: string; include_closed?: string } }>(
    '/kitchen/inventory',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            state: { type: 'string', enum: [...INVENTORY_STATES] },
            limit: { type: 'string', pattern: '^[0-9]+$' },
            include_closed: { type: 'string', enum: ['true', 'false'] },
          },
        },
      },
    },
    async (request) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      let states: InventoryState[] | undefined;
      if (request.query.state) states = [request.query.state as InventoryState];
      else if (request.query.include_closed === 'true') states = [...INVENTORY_STATES];
      const items = await inventory.listInventory({ states, limit });
      return { items, count: items.length };
    }
  );

  // Static path registered before /inventory/:ulid (find-my-way prefers literals).
  fastify.get<{ Querystring: { limit?: string } }>(
    '/kitchen/inventory/questions',
    { schema: { querystring: limitQuery } },
    async (request) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      const questions = await inventory.listQuestions(limit);
      return { questions, count: questions.length };
    }
  );

  fastify.get<{ Params: { ulid: string } }>('/kitchen/inventory/:ulid', async (request, reply) => {
    const item = await inventory.getItemView(request.params.ulid);
    if (!item) {
      reply.status(404);
      return { error: 'Inventory item not found' };
    }
    return item;
  });

  // ── Item creation (manual / agentic seed) ─────────────────────────────────────

  fastify.post<{ Body: Record<string, unknown> }>(
    '/kitchen/inventory',
    { schema: { body: ITEM_BODY_SCHEMA } },
    async (request, reply) => {
      const body = request.body ?? {};
      if (body.ulid !== undefined && !ULID_PATTERN.test(String(body.ulid))) {
        reply.status(400);
        return { error: 'ulid must be a valid ULID' };
      }
      const { item, created } = await inventory.createItem(body as never);
      reply.status(created ? 201 : 200);
      return item;
    }
  );

  // ── Free-text event resolver ──────────────────────────────────────────────────

  fastify.post<{ Body: { remark: string; at?: string } }>(
    '/kitchen/inventory/events',
    {
      schema: {
        body: {
          type: 'object',
          required: ['remark'],
          additionalProperties: false,
          properties: {
            remark: { type: 'string', minLength: 1, maxLength: 2000 },
            at: { type: 'string' },
          },
        },
      },
    },
    async (request) => {
      return inventory.resolveRemark(request.body.remark, request.body.at);
    }
  );

  // ── Explicit item event ───────────────────────────────────────────────────────

  fastify.post<{ Params: { ulid: string }; Body: { type: InventoryEventType; fraction?: number; at?: string } }>(
    '/kitchen/inventory/:ulid/events',
    {
      schema: {
        body: {
          type: 'object',
          required: ['type'],
          additionalProperties: false,
          properties: {
            type: { type: 'string', enum: [...INVENTORY_EVENT_TYPES] },
            fraction: { type: 'number', minimum: 0, maximum: 1 },
            at: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const item = await inventory.applyEvent(request.params.ulid, request.body.type, {
          fraction: request.body.fraction,
          at: request.body.at,
        });
        if (!item) {
          reply.status(404);
          return { error: 'Inventory item not found' };
        }
        return item;
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          reply.status(409);
          return { error: err.message };
        }
        throw err;
      }
    }
  );

  // ── Label intake ──────────────────────────────────────────────────────────────

  fastify.post<{ Params: { ulid: string } }>('/kitchen/inventory/:ulid/label', async (request, reply) => {
    if (!request.isMultipart()) {
      reply.status(400);
      return { error: 'multipart/form-data required (photo parts + optional label JSON part)' };
    }
    let collected;
    try {
      collected = await collectMultipart(request, 'label');
    } catch (err) {
      reply.status(400);
      return { error: `multipart parse failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (collected.error) {
      reply.status(400);
      return { error: collected.error };
    }
    const meta = (collected.meta ?? {}) as Record<string, unknown>;
    if (meta.shelf_life_class !== undefined && !SHELF_LIFE_CLASSES.includes(meta.shelf_life_class as ShelfLifeClass)) {
      reply.status(400);
      return { error: `label.shelf_life_class must be one of: ${SHELF_LIFE_CLASSES.join(', ')}` };
    }
    try {
      const result = await inventory.resolveLabel(request.params.ulid, collected.photos, {
        name: typeof meta.name === 'string' ? meta.name : undefined,
        shelf_life_class: meta.shelf_life_class as ShelfLifeClass | undefined,
        package_size: typeof meta.package_size === 'string' ? meta.package_size : undefined,
        aliases: Array.isArray(meta.aliases) ? (meta.aliases as string[]) : undefined,
      });
      if (!result) {
        reply.status(404);
        return { error: 'Inventory item not found' };
      }
      return result;
    } catch (err) {
      if (err instanceof LabelParserUnavailableError) {
        reply.status(503);
        return { error: err.message };
      }
      throw err;
    }
  });

  // ── Dismissal (non-grocery line removal) ──────────────────────────────────────

  fastify.post<{ Params: { ulid: string }; Body: { non_inventory?: boolean; at?: string } }>(
    '/kitchen/inventory/:ulid/dismiss',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            non_inventory: { type: 'boolean' },
            at: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await inventory.dismissItem(request.params.ulid, {
          nonInventory: request.body?.non_inventory,
          at: request.body?.at,
        });
        if (!result) {
          reply.status(404);
          return { error: 'Inventory item not found' };
        }
        return result;
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          reply.status(409);
          return { error: err.message };
        }
        throw err;
      }
    }
  );

  // ── Products ──────────────────────────────────────────────────────────────────

  fastify.post<{ Body: Record<string, unknown> }>(
    '/kitchen/products',
    { schema: { body: PRODUCT_BODY_SCHEMA } },
    async (request, reply) => {
      const product = await inventory.createProduct(request.body as never);
      reply.status(201);
      return product;
    }
  );

  fastify.get<{ Querystring: { q?: string; limit?: string } }>(
    '/kitchen/products',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { q: { type: 'string' }, limit: { type: 'string', pattern: '^[0-9]+$' } },
        },
      },
    },
    async (request) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      const products = await inventory.listProducts({ q: request.query.q, limit });
      return { products, count: products.length };
    }
  );

  // ── Lexicon ───────────────────────────────────────────────────────────────────

  fastify.post<{ Body: Record<string, unknown> }>(
    '/kitchen/lexicon',
    { schema: { body: LEXICON_BODY_SCHEMA } },
    async (request, reply) => {
      const line = await inventory.upsertLexicon(request.body as never);
      reply.status(201);
      return line;
    }
  );

  fastify.get<{ Querystring: { store?: string; limit?: string } }>(
    '/kitchen/lexicon',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { store: { type: 'string' }, limit: { type: 'string', pattern: '^[0-9]+$' } },
        },
      },
    },
    async (request) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      const lines = await inventory.listLexicon({ store: request.query.store, limit });
      return { lines, count: lines.length };
    }
  );
};

const limitQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { limit: { type: 'string', pattern: '^[0-9]+$' } },
} as const;

const NUTRITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    calories: { type: ['number', 'null'], minimum: 0 },
    protein_g: { type: ['number', 'null'], minimum: 0 },
    fat_g: { type: ['number', 'null'], minimum: 0 },
    sat_fat_g: { type: ['number', 'null'], minimum: 0 },
    carbs_g: { type: ['number', 'null'], minimum: 0 },
    sodium_mg: { type: ['number', 'null'], minimum: 0 },
  },
} as const;

const ITEM_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ulid: { type: 'string' },
    product_ulid: { type: 'string' },
    raw_label: { type: 'string', maxLength: 400 },
    store: { type: 'string', maxLength: 200 },
    batch_ulid: { type: 'string' },
    acquired_at: { type: 'string' },
    on_hand_fraction: { type: 'number', minimum: 0, maximum: 1 },
    state: { type: 'string', enum: [...INVENTORY_STATES] },
    needs_info: { type: 'boolean' },
    shelf_life_class: { type: 'string', enum: [...SHELF_LIFE_CLASSES] },
    notes: { type: 'string', maxLength: 2000 },
  },
} as const;

const PRODUCT_BODY_SCHEMA = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    shelf_life_class: { type: 'string', enum: [...SHELF_LIFE_CLASSES] },
    aliases: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 100 } },
    nutrition_per_100g: NUTRITION_SCHEMA,
    package_size: { type: 'string', maxLength: 100 },
    shelf_life_days_unopened: { type: 'number', minimum: 0 },
    shelf_life_days_opened: { type: 'number', minimum: 0 },
  },
} as const;

const LEXICON_BODY_SCHEMA = {
  type: 'object',
  required: ['store', 'line_text', 'product_ulid'],
  additionalProperties: false,
  properties: {
    store: { type: 'string', minLength: 1, maxLength: 200 },
    line_text: { type: 'string', minLength: 1, maxLength: 400 },
    product_ulid: { type: 'string', pattern: ULID_PATTERN.source },
    package_size: { type: 'string', maxLength: 100 },
    shelf_life_class: { type: 'string', enum: [...SHELF_LIFE_CLASSES] },
  },
} as const;
