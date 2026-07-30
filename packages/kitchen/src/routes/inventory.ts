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
 *   GET    /kitchen/inventory/waste        - costed toss log (waste + totals)
 *   GET    /kitchen/inventory/:ulid        - single item
 *   POST   /kitchen/inventory              - create an item (manual / seed)
 *   PATCH  /kitchen/inventory/:ulid        - reconcile: correct quantities/model/state (observation, not event)
 *   POST   /kitchen/inventory/events       - free-text event resolver
 *   POST   /kitchen/inventory/:ulid/events - explicit opened|finished|finished-unit|tossed|moved
 *   POST   /kitchen/inventory/:ulid/label  - multipart: label photo(s) → resolve needs-info
 *   POST   /kitchen/inventory/:ulid/dismiss - retire a record that was never real stock
 *   POST   /kitchen/inventory/:ulid/merge  - fold a duplicate item into a survivor
 *   POST   /kitchen/inventory/convert      - prep transform: decrement source(s), create a derived item
 *   POST   /kitchen/inventory/:ulid/consume - one-tap known-macro log + deplete, ONE atomic operation
 *   POST   /kitchen/inventory/:ulid/consumed - stated-weight consumption: a KNOWN amount eaten off a
 *                                              divisible item — a consumption, never a reconcile
 * Products & lexicon (agentic seed + reads):
 *   POST   /kitchen/products               - UPSERTS on an explicit ulid or the normalized name (201/200/409)
 *   GET    /kitchen/products               - live products (archived excluded)
 *   GET    /kitchen/products/:ulid/prices  - per-product price history, unit-normalized
 *   PATCH  /kitchen/products/:ulid         - partial correction; null clears, panels merge per-field
 *   POST   /kitchen/products/:ulid/merge   - fold a duplicate into a survivor: relink dependents, archive the loser
 *   DELETE /kitchen/products/:ulid         - archives (soft; still resolvable by ULID)
 *   POST   /kitchen/lexicon                GET /kitchen/lexicon
 *
 * Photos never touch disk (@fastify/multipart toBuffer holds them in memory
 * for the request only).
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { ULID_PATTERN } from '../ulid.js';
import { InvalidTransitionError } from '../inventory-state.js';
import {
  ConsumeIneligibleError,
  ConsumeNotConfiguredError,
  ConsumeValidationError,
  ConversionValidationError,
  ItemConflictError,
  ItemValidationError,
  LabelParserUnavailableError,
  NotCountedItemError,
  ProductConflictError,
  ProductValidationError,
  ReconcileValidationError,
  StatedConsumeConflictError,
  StatedConsumeNotConfiguredError,
  StatedConsumeValidationError,
  type InventoryPipeline,
} from '../services/inventory.js';
import {
  INVENTORY_EVENT_TYPES,
  INVENTORY_STATES,
  NUTRITION_SOURCES,
  SHELF_LIFE_CLASSES,
  STORAGE_MOVE_SHELF_LIFE_CLASSES,
  UNIT_SEALS,
  type ConsumeInput,
  type ConvertInput,
  type InventoryEventInput,
  type InventoryPhotoPart,
  type InventoryState,
  type ReconcileInput,
  type ShelfLifeClass,
  type StatedConsumeInput,
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

  // Static path registered before /inventory/:ulid (find-my-way prefers literals).
  fastify.get<{ Querystring: { since?: string; until?: string; limit?: string } }>(
    '/kitchen/inventory/waste',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            since: { type: 'string', pattern: ISO_DATE_PATTERN },
            until: { type: 'string', pattern: ISO_DATE_PATTERN },
            limit: { type: 'string', pattern: '^[0-9]+$' },
          },
        },
      },
    },
    async (request) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      return inventory.wasteReport({
        since: request.query.since,
        until: request.query.until,
        limit,
      });
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
      try {
        const { item, created } = await inventory.createItem(body as never);
        reply.status(created ? 201 : 200);
        return item;
      } catch (err) {
        return itemErrorReply(err, reply);
      }
    }
  );

  // ── Reconcile (§ Reconcile — correction, not consumption) ─────────────────────

  fastify.patch<{ Params: { ulid: string }; Body: ReconcileInput }>(
    '/kitchen/inventory/:ulid',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            on_hand_fraction: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
            units_total: { type: ['integer', 'null'], minimum: 1 },
            units_remaining: { type: ['integer', 'null'], minimum: 1 },
            unit_seal: { type: 'string', enum: [...UNIT_SEALS] },
            state: { type: 'string', enum: ['stocked', 'open'] },
            opened_at: { type: ['string', 'null'] },
            // § Reconcile — the fields a correction actually needs. A verb
            // documented as reconciling the ledger to reality that cannot reach
            // a wrong class, a wrong question flag, or a wrong product link is
            // only half a verb. `eat_by` stays absent on purpose: it is derived,
            // and an override would make the class stop meaning anything.
            shelf_life_class: { type: 'string', enum: [...SHELF_LIFE_CLASSES] },
            needs_info: { type: 'boolean' },
            product_ulid: { type: ['string', 'null'], pattern: ULID_PATTERN.source },
            notes: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const item = await inventory.reconcileItem(request.params.ulid, request.body ?? {});
        if (!item) {
          reply.status(404);
          return { error: 'Inventory item not found' };
        }
        return item;
      } catch (err) {
        if (err instanceof ReconcileValidationError || err instanceof NotCountedItemError) {
          reply.status(400);
          return { error: err.message };
        }
        throw err;
      }
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

  fastify.post<{ Params: { ulid: string }; Body: InventoryEventInput }>(
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
            // `moved` only (§ Storage moves): the class the item moved INTO.
            // `unknown` is excluded at the schema — a move states where the item
            // now lives, and `unknown` is not a place.
            to: { type: 'string', enum: [...STORAGE_MOVE_SHELF_LIFE_CLASSES] },
            at: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const item = await inventory.applyEvent(request.params.ulid, request.body.type, {
          fraction: request.body.fraction,
          to: request.body.to,
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
        if (err instanceof NotCountedItemError) {
          reply.status(400);
          return { error: err.message };
        }
        // A `moved` with no destination class, or a `to` on any other event type
        // (§ Storage moves) — malformed request, not an illegal transition.
        return itemErrorReply(err, reply);
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
        ingredients: typeof meta.ingredients === 'string' ? meta.ingredients : undefined,
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
      if (err instanceof InvalidTransitionError) {
        reply.status(409);
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

  // ── Item merge (fold a duplicate into a survivor) ─────────────────────────────

  // POST /kitchen/inventory/:ulid/merge - § Item corrections. `dismiss` retires a
  // row but relinks nothing, so for a duplicate with history on both sides it
  // strands a consumption entry, a receipt line, and a conversion against a
  // record that is no longer stock. Merge fills the survivor's null identity
  // fields, relinks every dependent, then retires the loser as `dismissed`.
  fastify.post<{ Params: { ulid: string }; Body: { into: string } }>(
    '/kitchen/inventory/:ulid/merge',
    { schema: { body: ITEM_MERGE_SCHEMA } },
    async (request, reply) => {
      try {
        const result = await inventory.mergeItems(request.params.ulid, request.body.into);
        if (!result) {
          reply.status(404);
          return { error: 'Inventory item not found (either the item being merged or the `into` survivor)' };
        }
        return result;
      } catch (err) {
        return itemErrorReply(err, reply);
      }
    }
  );

  // ── Conversions (prep transforms) ─────────────────────────────────────────────

  fastify.post<{ Body: ConvertInput }>(
    '/kitchen/inventory/convert',
    { schema: { body: CONVERT_BODY_SCHEMA } },
    async (request, reply) => {
      try {
        const result = await inventory.convert(request.body);
        // 200 on an idempotent replay of a caller-supplied derived.ulid —
        // mirroring consume's created/replay codes.
        reply.status(result.created ? 201 : 200);
        return result;
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          reply.status(409);
          return { error: err.message };
        }
        if (err instanceof ConversionValidationError) {
          reply.status(400);
          return { error: err.message };
        }
        throw err;
      }
    }
  );

  // ── Consume from inventory (one-tap known-macro log + deplete) ───────────────

  fastify.post<{ Params: { ulid: string }; Body: ConsumeInput }>(
    '/kitchen/inventory/:ulid/consume',
    { schema: { body: CONSUME_BODY_SCHEMA } },
    async (request, reply) => {
      try {
        const result = await inventory.consume(request.params.ulid, request.body);
        if (!result) {
          reply.status(404);
          return { error: 'Inventory item not found' };
        }
        reply.status(result.created ? 201 : 200);
        return result;
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          reply.status(409);
          return { error: err.message };
        }
        if (err instanceof ConsumeIneligibleError || err instanceof ConsumeValidationError) {
          reply.status(400);
          return { error: err.message };
        }
        if (err instanceof ConsumeNotConfiguredError) {
          reply.status(503);
          return { error: err.message };
        }
        throw err;
      }
    }
  );

  // ── Stated-weight consumption (§ Stated-weight consumption) ──────────────────
  //
  // A KNOWN weight or fraction eaten off an open, divisible item — a
  // CONSUMPTION, never `PATCH /inventory/:ulid` (reconcile is an observation
  // and carries no consumption claim by design). Distinct from `/consume`
  // above (a one-tap action for an item whose macros AND portion are already
  // both known); this is the ordinary case where a caller measured what left
  // the container.

  fastify.post<{ Params: { ulid: string }; Body: StatedConsumeInput }>(
    '/kitchen/inventory/:ulid/consumed',
    { schema: { body: STATED_CONSUME_BODY_SCHEMA } },
    async (request, reply) => {
      try {
        const result = await inventory.consumeStatedAmount(request.params.ulid, request.body);
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
        if (err instanceof StatedConsumeConflictError) {
          reply.status(409);
          return { error: err.message };
        }
        if (err instanceof StatedConsumeValidationError) {
          reply.status(400);
          return { error: err.message };
        }
        if (err instanceof StatedConsumeNotConfiguredError) {
          reply.status(503);
          return { error: err.message };
        }
        throw err;
      }
    }
  );

  // ── Products ──────────────────────────────────────────────────────────────────

  // POST /kitchen/products - UPSERTS (specs/modules/kitchen.md § Product
  // corrections): 201 on create, 200 on an explicit-ulid replace or a name-key
  // enrich, 409 on an ambiguous name key or an archived target. `ulid` is a
  // real key here — it used to be stripped by `additionalProperties: false`,
  // minting a duplicate and answering 201 for a write that ignored the request.
  fastify.post<{ Body: Record<string, unknown> }>(
    '/kitchen/products',
    { schema: { body: PRODUCT_BODY_SCHEMA } },
    async (request, reply) => {
      try {
        const { product, created } = await inventory.upsertProduct(request.body as never);
        reply.status(created ? 201 : 200);
        return product;
      } catch (err) {
        return productErrorReply(err, reply);
      }
    }
  );

  // PATCH /kitchen/products/:ulid - partial correction (§ Product corrections).
  // Only supplied keys change; explicit null clears; both nutrition panels merge
  // per-field so filling one missing field never restates the other eight.
  fastify.patch<{ Params: { ulid: string }; Body: Record<string, unknown> }>(
    '/kitchen/products/:ulid',
    { schema: { body: PRODUCT_PATCH_SCHEMA } },
    async (request, reply) => {
      try {
        const product = await inventory.patchProduct(request.params.ulid, request.body as never);
        if (!product) {
          reply.status(404);
          return { error: 'Product not found' };
        }
        return product;
      } catch (err) {
        return productErrorReply(err, reply);
      }
    }
  );

  // POST /kitchen/products/:ulid/merge - fold a duplicate into a survivor
  // (§ Product corrections). Items, lexicon lines, and batch lines point at the
  // loser, so a plain delete would orphan them; merge relinks then archives.
  fastify.post<{ Params: { ulid: string }; Body: { into: string } }>(
    '/kitchen/products/:ulid/merge',
    { schema: { body: PRODUCT_MERGE_SCHEMA } },
    async (request, reply) => {
      try {
        const result = await inventory.mergeProducts(request.params.ulid, request.body.into);
        if (!result) {
          reply.status(404);
          return { error: 'Product not found (either the product being merged or the `into` survivor)' };
        }
        return result;
      } catch (err) {
        return productErrorReply(err, reply);
      }
    }
  );

  // DELETE /kitchen/products/:ulid - ARCHIVES (§ Product corrections). Never a
  // row deletion: items, lexicon lines, and batch lines point at products and
  // must keep resolving. Idempotent.
  fastify.delete<{ Params: { ulid: string } }>('/kitchen/products/:ulid', async (request, reply) => {
    const archived = await inventory.archiveProduct(request.params.ulid);
    if (!archived) {
      reply.status(404);
      return { error: 'Product not found' };
    }
    return archived;
  });

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

  fastify.get<{ Params: { ulid: string }; Querystring: { store?: string; limit?: string } }>(
    '/kitchen/products/:ulid/prices',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { store: { type: 'string' }, limit: { type: 'string', pattern: '^[0-9]+$' } },
        },
      },
    },
    async (request, reply) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      const history = await inventory.priceHistory(request.params.ulid, {
        store: request.query.store,
        limit,
      });
      if (!history) {
        reply.status(404);
        return { error: 'Product not found' };
      }
      return history;
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

/** ISO date-only (`YYYY-MM-DD`), the form the waste read's window bounds take. */
const ISO_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

const limitQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { limit: { type: 'string', pattern: '^[0-9]+$' } },
} as const;

/**
 * Map a product-write failure to its status (§ Product corrections): a malformed
 * request is `400`, an unhonorable one is `409`. Shared by all four product
 * write routes so no door can quietly answer with a different code — or worse,
 * with a success.
 */
function productErrorReply(err: unknown, reply: FastifyReply): { error: string } {
  if (err instanceof ProductValidationError) {
    reply.status(400);
    return { error: err.message };
  }
  if (err instanceof ProductConflictError) {
    reply.status(409);
    return { error: err.message };
  }
  throw err;
}

/**
 * Map an item-write failure to its status, mirroring `productErrorReply`: a
 * malformed request is `400`, an unhonorable one `409`. Shared by every item
 * write that can raise them — create, the event surface, and merge — so no door
 * can quietly answer with a different code.
 */
function itemErrorReply(err: unknown, reply: FastifyReply): { error: string } {
  if (err instanceof ItemValidationError) {
    reply.status(400);
    return { error: err.message };
  }
  if (err instanceof ItemConflictError) {
    reply.status(409);
    return { error: err.message };
  }
  throw err;
}

const ITEM_MERGE_SCHEMA = {
  type: 'object',
  required: ['into'],
  additionalProperties: false,
  properties: { into: { type: 'string', pattern: ULID_PATTERN.source } },
} as const;

const NUTRITION_SCHEMA = {
  // Nullable: on a product write, `null` clears the whole panel (a patch clears
  // a single field by supplying that field as null instead).
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    calories: { type: ['number', 'null'], minimum: 0 },
    protein_g: { type: ['number', 'null'], minimum: 0 },
    fat_g: { type: ['number', 'null'], minimum: 0 },
    sat_fat_g: { type: ['number', 'null'], minimum: 0 },
    carbs_g: { type: ['number', 'null'], minimum: 0 },
    sodium_mg: { type: ['number', 'null'], minimum: 0 },
    fiber_g: { type: ['number', 'null'], minimum: 0 },
    sugar_g: { type: ['number', 'null'], minimum: 0 },
    added_sugar_g: { type: ['number', 'null'], minimum: 0 },
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
    units_total: { type: 'integer', minimum: 1 },
    unit_seal: { type: 'string', enum: [...UNIT_SEALS] },
    state: { type: 'string', enum: [...INVENTORY_STATES] },
    needs_info: { type: 'boolean' },
    shelf_life_class: { type: 'string', enum: [...SHELF_LIFE_CLASSES] },
    notes: { type: 'string', maxLength: 2000 },
  },
} as const;

const CONSUME_BODY_SCHEMA = {
  type: 'object',
  required: ['ulid'],
  additionalProperties: false,
  properties: {
    // The consumption entry's client-generated ULID — the idempotency key.
    ulid: { type: 'string', pattern: ULID_PATTERN.source },
    // Counted items only (whole sealed units consumed this tap); a fraction
    // item always fully finishes in one consume, so this must be 1/omitted
    // there (enforced in the pipeline, which has the item's on-hand model).
    quantity: { type: 'integer', minimum: 1 },
    at: { type: 'string' },
  },
} as const;

const STATED_CONSUME_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // Exactly one of amount_g/fraction is required — enforced in the
    // pipeline, which knows whether the item's linked product carries a
    // mass basis (net_content_g) for amount_g.
    amount_g: { type: 'number', exclusiveMinimum: 0 },
    fraction: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
    // An ALREADY-LOGGED consuming journal entry's ulid — also the
    // idempotency key for the atomic link+deplete (§ Stated-weight
    // consumption). Omitted, the depletion still records; it just isn't
    // linked to one specific entry.
    entry_ulid: { type: 'string', pattern: ULID_PATTERN.source },
    at: { type: 'string' },
  },
} as const;

const CONVERT_SOURCE_SCHEMA = {
  type: 'object',
  required: ['item_ulid'],
  additionalProperties: false,
  properties: {
    item_ulid: { type: 'string', pattern: ULID_PATTERN.source },
    amount: { type: 'number', minimum: 0 },
  },
} as const;

const CONVERT_DERIVED_SCHEMA = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    // Optional client-supplied derived ULID = the conversion's idempotency key
    // (§ Conversions § Retries). Omitted → server-minted, non-deduplicating.
    ulid: { type: 'string', pattern: ULID_PATTERN.source },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    shelf_life_class: { type: 'string', enum: [...SHELF_LIFE_CLASSES] },
    on_hand_fraction: { type: 'number', minimum: 0, maximum: 1 },
    units_total: { type: 'integer', minimum: 1 },
    unit_seal: { type: 'string', enum: [...UNIT_SEALS] },
    store: { type: 'string', maxLength: 200 },
    notes: { type: 'string', maxLength: 2000 },
    acquired_at: { type: 'string' },
    recipe_ulid: { type: 'string' },
  },
} as const;

const CONVERT_BODY_SCHEMA = {
  type: 'object',
  required: ['derived'],
  additionalProperties: false,
  properties: {
    // Optional: a source-less conversion registers a prepared item
    // ("I made this") without decrementing any tracked stock.
    sources: { type: 'array', minItems: 0, items: CONVERT_SOURCE_SCHEMA },
    derived: CONVERT_DERIVED_SCHEMA,
    at: { type: 'string' },
  },
} as const;

/**
 * The stored product facts a caller may state, shared by the upsert body and the
 * patch body (which widens each to accept an explicit null). Single-sourced so a
 * new product field can't reach one door and not the other.
 */
const PRODUCT_FACT_PROPERTIES = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  shelf_life_class: { type: 'string', enum: [...SHELF_LIFE_CLASSES] },
  aliases: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 100 } },
  nutrition_per_100g: NUTRITION_SCHEMA,
  nutrition_per_serving: NUTRITION_SCHEMA,
  serving_size_g: { type: ['number', 'null'], exclusiveMinimum: 0 },
  servings_per_container: { type: ['number', 'null'], exclusiveMinimum: 0 },
  unit_model_hint: { type: ['string', 'null'], enum: ['counted', 'fraction', null] },
  net_content_g: { type: ['number', 'null'], exclusiveMinimum: 0 },
  net_content_ml: { type: ['number', 'null'], exclusiveMinimum: 0 },
  ingredients: { type: ['string', 'null'], maxLength: 4000 },
  package_size: { type: ['string', 'null'], maxLength: 100 },
  shelf_life_days_unopened: { type: ['number', 'null'], minimum: 0 },
  shelf_life_days_opened: { type: ['number', 'null'], minimum: 0 },
  // § Per-unit edible grams and panel provenance. STATED, never derived —
  // there is no code path that computes this from serving_size_g or from
  // net_content_g ÷ units_total; both are wrong in opposite directions.
  unit_edible_g: { type: ['number', 'null'], exclusiveMinimum: 0 },
  // Where the panel came from. One-directional supersession applies to the
  // AUTOMATED name-key enrich only (never downgrades an existing 'label') —
  // an explicit-ulid replace or a PATCH is the owner stating a fact, and the
  // stated value applies as given. See resolveNutritionSource.
  nutrition_source: { type: ['string', 'null'], enum: [...NUTRITION_SOURCES, null] },
  // § Nutritionally negligible products — the ~0-at-any-realistic-serving
  // assertion that lets `needs_nutrition` be satisfied honestly for spices,
  // dried herbs, vinegar, and the rest of the panel-exempt categories. NOT
  // salt: it is ~0 on eight fields and ~38,700 mg/100 g of sodium on the ninth,
  // so the sodium guard refuses it (§ Sodium is the exception that breaks the
  // marker) unless `nutrition_negligible_override` says otherwise.
  nutrition_negligible: { type: 'boolean' },
  // Request-only, never stored: apply the marker anyway. Lives on both bodies
  // rather than in the stored-facts set because it is an instruction about THIS
  // write, not a fact about the product.
  nutrition_negligible_override: { type: 'boolean' },
} as const;

// `ulid` is a REAL upsert key (§ Product corrections). Its absence here — with
// `additionalProperties: false` — is what made a supplied ULID vanish silently
// and a duplicate come back as 201.
const PRODUCT_BODY_SCHEMA = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    ulid: { type: 'string', pattern: ULID_PATTERN.source },
    ...PRODUCT_FACT_PROPERTIES,
  },
} as const;

// A patch states only what changes (`minProperties: 1`), and `null` clears.
// `ulid` is not patchable — identity is not a fact about the product.
const PRODUCT_PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: PRODUCT_FACT_PROPERTIES,
} as const;

const PRODUCT_MERGE_SCHEMA = {
  type: 'object',
  required: ['into'],
  additionalProperties: false,
  properties: { into: { type: 'string', pattern: ULID_PATTERN.source } },
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
