/**
 * Kitchen Module Plugin Entry Point
 *
 * Consumption journal: entries, estimation, recipes (phase 1 of
 * specs/modules/kitchen.md). Sibling of the capture module — same
 * structural idioms (ULID-keyed idempotent upserts, status-as-work-queue,
 * store interface with pg/memory implementations, sweep worker, Fastify
 * routes) applied to its own `/api/kitchen/*` surface.
 *
 * Single-user by design: no sharing or multi-user surfaces.
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import {
  createPlugin,
  type PluginOptions,
  type Scheduler,
} from '@jarvus/claude-assist-core';
import { PgEntryStore, PgRecipeStore } from './store.js';
import { KitchenEstimator } from './services/estimator.js';
import { KitchenPipeline } from './services/pipeline.js';
import { readMealBankRecipes } from './services/mealbank.js';
import { registerKitchenRoutes } from './routes/kitchen.js';

// Module augmentation for fastify decorators
declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
  }
}

export const KITCHEN_PIPELINE_NAME = 'kitchen-estimation';

export default createPlugin('kitchen', async (fastify: FastifyInstance, options: PluginOptions) => {
  const config = options.kitchenConfig ?? {};

  const entryStore = new PgEntryStore(fastify.sql);
  const recipeStore = new PgRecipeStore(fastify.sql);

  // Estimator (optional — requires anthropicApiKey; without it, entries sit
  // in `estimating` until either a key is configured or the owner supplies
  // a manual correction).
  let estimator: KitchenEstimator | null = null;
  if (config.anthropicApiKey) {
    estimator = new KitchenEstimator(
      { apiKey: config.anthropicApiKey, model: config.estimationModel },
      fastify.log
    );
    fastify.log.info('Kitchen estimator enabled');
  } else {
    fastify.log.warn('anthropicApiKey not set - kitchen entries will remain in estimating status');
  }

  const readSheetRecipes =
    config.mealBankRepoPath && config.mealBankSheet
      ? () => readMealBankRecipes({ repoPath: config.mealBankRepoPath, sheetName: config.mealBankSheet }, fastify.log)
      : undefined;

  const pipeline = new KitchenPipeline(entryStore, recipeStore, estimator, fastify.log, {
    concurrency: config.concurrency,
    readSheetRecipes,
  });

  await fastify.register(registerKitchenRoutes, {
    pipeline,
    maxPhotoBytes: config.maxPhotoBytes,
    maxPhotos: config.maxPhotos,
  });

  if (!config.disableEstimation) {
    fastify.scheduler.register({
      name: 'kitchen:estimate',
      schedule: '* * * * *', // every minute — mirrors capture's "should feel instant"
      runOnStartup: true,
      handler: async () => {
        const result = await pipeline.sweep();
        const activity = Object.values(result).some((count) => count > 0);
        if (activity) {
          fastify.log.info({ result }, 'Kitchen estimation sweep complete');
        }
      },
    });
  } else {
    fastify.log.info('Kitchen estimation sweep disabled via config');
  }
});

// Re-exports for clients (tests, future modules, briefing source)
export * from './types.js';
export { generateUlid, ulidFromSeed, isValidUlid, ULID_PATTERN } from './ulid.js';
export { transition, InvalidTransitionError, type EntryEvent } from './state.js';
export type { EntryStore, RecipeStore, NewEntry, NewRecipe, RecentEntrySummary } from './store.js';
export { PgEntryStore, PgRecipeStore, normalizeNewEntry, EMPTY_NUTRITION } from './store.js';
export { MemoryEntryStore, MemoryRecipeStore } from './memory-store.js';
export {
  KitchenPipeline,
  RecipeNotFoundError,
  ManualOverrideConflictError,
  PatchValidationError,
  PromoteNotReadyError,
  type SweepResult,
  type ReselectStrip,
} from './services/pipeline.js';
export {
  KitchenEstimator,
  portionModifierFor,
  applyPortionModifier,
  type Estimator,
  type EstimateInput,
} from './services/estimator.js';
export { computeRecipeMacros } from './services/recipes.js';
export { readMealBankRecipes, type MealBankConfig } from './services/mealbank.js';
export { registerKitchenRoutes, type KitchenRoutesConfig } from './routes/kitchen.js';
