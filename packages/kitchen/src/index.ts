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
import { registerPlanSessionRoutes } from './routes/plan-session.js';
import { PgInventoryStore } from './inventory-store.js';
import { KitchenReceiptParser } from './services/receipt-parser.js';
import { KitchenLabelParser } from './services/label-parser.js';
import { InventoryPipeline } from './services/inventory.js';
import { registerInventoryRoutes } from './routes/inventory.js';
import type { EventResolution } from './inventory-types.js';
import type { RecipeRecord } from './types.js';

/** The kitchen module's ambient-remark resolver surface (phase-2 seam). */
export interface KitchenEventsSurface {
  /** Resolve a free-text remark into an inventory state change (best-effort). */
  resolve(remark: string, at?: string): Promise<EventResolution>;
}

/**
 * The kitchen module's merged-recipe surface (phase-2 seam): the full
 * sheet + pushed + promoted view the reselect pipeline merges. The server
 * composes the briefing's stock-aware suggestion provider from this.
 */
export interface KitchenRecipesSurface {
  listAll(): Promise<RecipeRecord[]>;
}

// Module augmentation for fastify decorators
declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
    /**
     * Ambient-remark resolver, present only when the kitchen module is loaded.
     * The server reads this to compose the capture module's kitchen_event
     * executor (the two packages never import each other).
     */
    kitchenEvents?: KitchenEventsSurface;
    /**
     * Merged recipe view (sheet + pushed + promoted), present only when the
     * kitchen module is loaded. The server reads this to compose the briefing
     * module's stock-aware suggestion provider (no cross-package import).
     */
    kitchenRecipes?: KitchenRecipesSurface;
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

  // ── Inventory (phase 2) ─────────────────────────────────────────────────────
  // Receipt parsing runs on the cheap tier; label extraction on the strong
  // (estimation) tier. Both require the API key — without it, receipts still
  // post and their lines land as needs_info items, and label intake 503s.
  const inventoryStore = new PgInventoryStore(fastify.sql);
  const receiptParser = config.anthropicApiKey
    ? new KitchenReceiptParser({ apiKey: config.anthropicApiKey, model: config.receiptModel }, fastify.log)
    : null;
  const labelParser = config.anthropicApiKey
    ? new KitchenLabelParser({ apiKey: config.anthropicApiKey, model: config.estimationModel }, fastify.log)
    : null;

  const inventory = new InventoryPipeline(inventoryStore, receiptParser, labelParser, fastify.log, {
    linkEntry: (entryUlid, itemUlid) => entryStore.linkInventoryItem(entryUlid, itemUlid),
  });

  const pipeline = new KitchenPipeline(entryStore, recipeStore, estimator, fastify.log, {
    concurrency: config.concurrency,
    readSheetRecipes,
    // Depletion matcher: an estimated entry plausibly depletes an on-hand item.
    onEntryEstimated: (entry) =>
      inventory.matchAndDeplete({ ulid: entry.ulid, label: entry.label, status: entry.status }).then(() => undefined),
  });

  await fastify.register(registerKitchenRoutes, {
    pipeline,
    maxPhotoBytes: config.maxPhotoBytes,
    maxPhotos: config.maxPhotos,
  });

  await fastify.register(registerInventoryRoutes, {
    inventory,
    maxPhotoBytes: config.maxPhotoBytes,
    maxPhotos: config.maxPhotos,
  });

  // Plan-session — app-initiated warm meal-planning session. Reads the generic
  // `fastify.sessionSpawner` decorator (from the session-spawn module) at
  // request time; 503s when it's absent/unconfigured.
  await fastify.register(registerPlanSessionRoutes, { pipeline, inventory });

  // Ambient-remark seam: expose the resolver for the capture kitchen_event
  // executor (composed by the server; the packages never import each other).
  fastify.decorate('kitchenEvents', {
    resolve: (remark: string, at?: string) => inventory.resolveRemark(remark, at),
  } satisfies KitchenEventsSurface);

  // Merged-recipe seam: expose the full sheet+pushed+promoted view for the
  // briefing's stock-aware suggestions (composed by the server, same pattern).
  fastify.decorate('kitchenRecipes', {
    listAll: () => pipeline.listAllRecipes(),
  } satisfies KitchenRecipesSurface);

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
export { registerPlanSessionRoutes, type PlanSessionRoutesConfig } from './routes/plan-session.js';
export {
  gatherPlanningContext,
  composePreloadPrompt,
  sumEffectiveTotals,
  PLAN_SESSION_TITLE,
  type PlanningContext,
  type PlanningContextConfig,
  type MacroTotals,
} from './services/plan-session.js';

// ── Phase 2: inventory ────────────────────────────────────────────────────────
export * from './inventory-types.js';
export {
  SHELF_LIFE_WINDOWS,
  deriveEatBy,
  toItemView,
  toIsoDate,
  addDays,
  dayDiff,
} from './inventory-derive.js';
export {
  transitionInventory,
  isTerminal,
  InvalidTransitionError as InvalidInventoryTransitionError,
} from './inventory-state.js';
export { parseRemark, matchScore, type ParsedRemark } from './inventory-remark.js';
export {
  PgInventoryStore,
  DEFAULT_ON_HAND_ITEM_STATES,
  type InventoryStore,
  type NewProduct,
  type NewItem,
  type NewBatch,
  type NewBatchLine,
  type NewLexicon,
} from './inventory-store.js';
export { MemoryInventoryStore } from './inventory-memory-store.js';
export {
  InventoryPipeline,
  LabelParserUnavailableError,
  normalizeLine,
  candidateStrings,
  parseDate,
  type InventoryPipelineConfig,
  type DepletableEntry,
} from './services/inventory.js';
export {
  KitchenReceiptParser,
  type ReceiptParser,
  type ReceiptParseInput,
} from './services/receipt-parser.js';
export {
  KitchenLabelParser,
  type LabelParser,
  type LabelParseInput,
} from './services/label-parser.js';
export { registerInventoryRoutes, type InventoryRoutesConfig } from './routes/inventory.js';
