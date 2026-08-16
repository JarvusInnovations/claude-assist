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
import type { RecipeStore } from '../store.js';
import type { RecipeRecord } from '../types.js';
import { PrepService, PrepValidationError, type PrepPublishInput } from '../services/prep.js';

export interface PrepRoutesConfig {
  store: InventoryStore;
  recipes?: RecipeStore;
  /**
   * Resolves a derived component's recipe across the merged (sheet + pushed
   * + promoted) universe — the same resolver `consume` uses
   * (§ Authoring a prep worksheet § A derived component resolves through its
   * recipe, not a product). Absent → a sheet naming a derived item is
   * refused rather than resolved through a narrower lookup.
   */
  resolveRecipe?: (recipeUlid: string) => Promise<RecipeRecord | null>;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const registerPrepRoutes: FastifyPluginAsync<PrepRoutesConfig> = async (
  fastify: FastifyInstance,
  { store, recipes, resolveRecipe }: PrepRoutesConfig
) => {
  fastify.post<{ Body: PrepPublishInput }>(
    '/kitchen/prep',
    {
      schema: {
        body: {
          type: 'object',
          required: ['slug', 'label'],
          additionalProperties: false,
          properties: {
            slug: { type: 'string' },
            recipe_ulid: { type: 'string' },
            label: { type: 'string', minLength: 1 },
            title: { type: 'string' },
            heading: { type: 'string' },
            intro: { type: 'string' },
            steps: { type: 'array', items: { type: 'string' } },
            submit_label: { type: 'string' },
            digest_optin: { type: 'boolean' },
            components: {
              type: 'array',
              items: {
                type: 'object',
                required: ['quantity'],
                additionalProperties: false,
                properties: {
                  product_ulid: { type: 'string' },
                  item_ulid: { type: 'string' },
                  quantity: { type: 'number', minimum: 0 },
                  counted: { type: 'boolean' },
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
        const result = await new PrepService(store, publisher, recipes, resolveRecipe).publish(request.body);
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
