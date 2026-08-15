/**
 * POST /kitchen/prep — publish a prep worksheet built from the catalog
 * (specs/modules/kitchen.md § Authoring a prep worksheet).
 *
 * Reads the generic `fastify.pages` decorator (core's `PagePublisher`, provided
 * by the pages module) at REQUEST time and 503s when it is absent — the same
 * optional-seam shape the plan-session route uses for `sessionSpawner`. The two
 * packages never import each other; the server composes them.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { InventoryStore } from '../inventory-store.js';
import { PrepService, PrepValidationError, type PrepPublishInput } from '../services/prep.js';

export interface PrepRoutesConfig {
  store: InventoryStore;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const registerPrepRoutes: FastifyPluginAsync<PrepRoutesConfig> = async (
  fastify: FastifyInstance,
  { store }: PrepRoutesConfig
) => {
  fastify.post<{ Body: PrepPublishInput }>(
    '/kitchen/prep',
    {
      schema: {
        body: {
          type: 'object',
          required: ['slug', 'label', 'components'],
          additionalProperties: false,
          properties: {
            slug: { type: 'string' },
            label: { type: 'string', minLength: 1 },
            title: { type: 'string' },
            heading: { type: 'string' },
            intro: { type: 'string' },
            steps: { type: 'array', items: { type: 'string' } },
            submit_label: { type: 'string' },
            digest_optin: { type: 'boolean' },
            components: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['quantity'],
                additionalProperties: false,
                properties: {
                  product_ulid: { type: 'string' },
                  item_ulid: { type: 'string' },
                  quantity: { type: 'number', minimum: 0 },
                  label: { type: 'string' },
                  note: { type: 'string' },
                },
              },
            },
            cook: {
              type: 'object',
              required: ['disposition'],
              additionalProperties: false,
              properties: {
                disposition: { type: 'string', enum: ['eaten', 'packed'] },
                units: { type: 'number' },
                shelf_life_class: { type: 'string' },
                recipe_ulid: { type: 'string' },
                sources: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['item_ulid'],
                    additionalProperties: false,
                    properties: { item_ulid: { type: 'string' }, amount: { type: 'number' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const publisher = fastify.pages;
      if (!publisher) {
        reply.status(503);
        return { error: 'pages module is not available — a prep worksheet has nowhere to publish' };
      }
      if (!SLUG_PATTERN.test(request.body.slug)) {
        reply.status(400);
        return { error: 'slug must be lowercase kebab-case' };
      }

      try {
        const result = await new PrepService(store, publisher).publish(request.body);
        reply.status(result.created ? 201 : 200);
        return result;
      } catch (err) {
        if (err instanceof PrepValidationError || (err as Error)?.name === 'WorksheetValidationError') {
          reply.status(400);
          return { error: (err as Error).message };
        }
        throw err;
      }
    }
  );
};
