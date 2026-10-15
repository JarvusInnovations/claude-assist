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
  type ActivityHistoryProvider,
  type PluginOptions,
  type Scheduler,
  type WorksheetCookSink,
} from '@jarvus/claude-assist-core';
import { PgEntryStore, PgExpenditureStore, PgRecipeStore, PgStravaOAuthStore, PgWeighInStore } from './store.js';
import { KitchenEstimator } from './services/estimator.js';
import { KitchenPipeline } from './services/pipeline.js';
import { readMealBankRecipes } from './services/mealbank.js';
import { registerKitchenRoutes } from './routes/kitchen.js';
import { registerExpenditureRoutes } from './routes/expenditures.js';
import { registerWeighInRoutes } from './routes/weigh-ins.js';
import { parseDailyTargets } from './daily-targets.js';
import { resolveOwnerTz } from './zoned.js';
import { registerPlanSessionRoutes } from './routes/plan-session.js';
import { PgInventoryStore } from './inventory-store.js';
import { KitchenReceiptParser } from './services/receipt-parser.js';
import { KitchenLabelParser } from './services/label-parser.js';
import { InventoryPipeline } from './services/inventory.js';
import { PgConsumeStore } from './services/consume-store.js';
import { StravaClient } from './services/strava-client.js';
import { createActivityHistoryProvider } from './services/activity-history.js';
import {
  StravaSync,
  isStravaSyncConfigured,
  parseStravaSyncMinutes,
  stravaSyncCron,
} from './services/strava-sync.js';
import { registerInventoryRoutes } from './routes/inventory.js';
import { registerPrepRoutes } from './routes/prep.js';
import { KitchenCookMode } from './services/cook-mode.js';
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

/**
 * The kitchen module's cook-mode surface (§ Cook mode): a worksheet submission
 * lands as a directly-stated entry (eaten) or a conversion (packed). The server
 * injects this into the pages module's config as its `worksheetCookSink`, so the
 * two packages never import each other. Structurally a `WorksheetCookSink`.
 */
export type KitchenCookModeSurface = WorksheetCookSink;

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
    /**
     * Worksheet cook-mode sink, present only when the kitchen module is loaded.
     * The server reads this to configure the pages module's cook-mode seam.
     */
    kitchenCookMode?: KitchenCookModeSurface;
    /**
     * Read-only activity history over this module's Strava credentials, present
     * only when they are configured. The server reads this to compose a sibling
     * module's activity-history provider — one refresh-token rotator per
     * instance, however many consumers there are.
     */
    kitchenActivityHistory?: ActivityHistoryProvider;
  }
}

export const KITCHEN_PIPELINE_NAME = 'kitchen-estimation';

export default createPlugin('kitchen', async (fastify: FastifyInstance, options: PluginOptions) => {
  const config = options.kitchenConfig ?? {};

  // Owner timezone (§ Timezone & local-day bucketing) — resolved once and
  // threaded into every route that computes a local day. A present-but-invalid
  // zone throws here and fails boot loudly (same doctrine as KITCHEN_DAILY_TARGETS);
  // unset ⇒ UTC fallback, stated in affected output.
  const ownerTz = resolveOwnerTz(config.ownerTz, config.dayStartHour);
  if (ownerTz.fallback) {
    fastify.log.warn('KITCHEN_OWNER_TZ unset — local-day bucketing falls back to UTC (stated in output)');
  } else {
    fastify.log.info({ zone: ownerTz.zone }, 'Kitchen owner timezone configured');
  }
  if (ownerTz.dayStartHour !== 0) {
    fastify.log.info(
      { dayStartHour: ownerTz.dayStartHour },
      'Kitchen consumption day rolls over after midnight (entries + expenditures only)'
    );
  }

  const entryStore = new PgEntryStore(fastify.sql);
  const recipeStore = new PgRecipeStore(fastify.sql);

  // Estimator (optional — requires the metered-model invoker; without it,
  // entries sit in `estimating` until either the invoker is configured or the
  // owner supplies a manual correction).
  let estimator: KitchenEstimator | null = null;
  if (fastify.invoker?.enabled) {
    estimator = new KitchenEstimator(
      { invoker: fastify.invoker, ...(config.estimationModel ? { model: config.estimationModel } : {}) },
      fastify.log
    );
    fastify.log.info('Kitchen estimator enabled');
  } else {
    fastify.log.warn(
      'The model invoker is unavailable - kitchen entries will remain in estimating status'
    );
  }

  const readSheetRecipes =
    config.mealBankRepoPath && config.mealBankSheet
      ? () => readMealBankRecipes({ repoPath: config.mealBankRepoPath, sheetName: config.mealBankSheet }, fastify.log)
      : undefined;

  // ── Inventory (phase 2) ─────────────────────────────────────────────────────
  // Receipt parsing runs on the cheap extract tier; label extraction on the
  // vision tier. Both need the invoker — without it, receipts still post and
  // their lines land as needs_info items, and label intake 503s.
  const inventoryStore = new PgInventoryStore(fastify.sql);
  const receiptParser = fastify.invoker?.enabled
    ? new KitchenReceiptParser(
        { invoker: fastify.invoker, ...(config.receiptModel ? { model: config.receiptModel } : {}) },
        fastify.log
      )
    : null;
  const labelParser = fastify.invoker?.enabled
    ? new KitchenLabelParser(
        { invoker: fastify.invoker, ...(config.estimationModel ? { model: config.estimationModel } : {}) },
        fastify.log
      )
    : null;

  // `pipeline` (KitchenPipeline) is declared here and assigned below so
  // `inventory`'s `resolveRecipe` closure can reference it — the two
  // pipelines have a genuine mutual dependency (inventory.consume() needs
  // pipeline.listAllRecipes() for macro inheritance; pipeline's
  // onEntryEstimated needs inventory.matchAndDeplete()). Both references are
  // inside callbacks invoked only at request time, long after both are
  // constructed, so the forward reference is safe.
  let pipeline: KitchenPipeline;

  // Macro inheritance for a derived item's provenance recipe, across the SAME
  // merged (sheet + pushed + promoted) universe the reselect strip serves —
  // shared by consume() and prep-worksheet derived-item resolution
  // (claude-assist#199) so the two surfaces can never disagree about which
  // recipes are usable for the same item. Defined here (before `pipeline` is
  // assigned) as a closure rather than a direct call: `inventory` below has a
  // genuine construction-order dependency on it, `pipeline` doesn't exist
  // yet, and the closure is only invoked later, at request time.
  const resolveMergedRecipe = async (recipeUlid: string): Promise<RecipeRecord | null> => {
    const all = await pipeline.listAllRecipes();
    return all.find((r) => r.ulid === recipeUlid) ?? null;
  };

  const inventory = new InventoryPipeline(inventoryStore, receiptParser, labelParser, fastify.log, {
    // Same resolved zone the entries/expenditure/weigh-in routes bucket by, so
    // an item's dates and the journal entry for the same act agree on the day.
    ownerTz,
    linkEntry: (entryUlid, itemUlid, applied) =>
      entryStore.linkInventoryItem(entryUlid, itemUlid, applied),
    // The entries half of an item merge (§ Item corrections) — same store seam.
    relinkEntries: (fromItemUlid, toItemUlid) => entryStore.relinkInventoryItem(fromItemUlid, toItemUlid),
    // Atomic entry+deplete write for consume() (claude-assist#110) — see
    // services/consume-store.ts for why this crosses into kitchen.entries.
    consumeStore: new PgConsumeStore(fastify.sql),
    resolveRecipe: resolveMergedRecipe,
  });

  pipeline = new KitchenPipeline(entryStore, recipeStore, estimator, fastify.log, {
    concurrency: config.concurrency,
    readSheetRecipes,
    // Depletion matcher: an estimated entry plausibly depletes an on-hand item.
    // The whole record is handed over (EntryRecord structurally satisfies
    // DepletableEntry) rather than a field-picked subset — the matcher needs
    // `inventory_item_ulid` as its idempotency key, and a hand-written pick is
    // exactly how that would get silently dropped again.
    onEntryEstimated: (entry) => inventory.matchAndDeplete(entry).then(() => undefined),
  });

  await fastify.register(registerKitchenRoutes, {
    pipeline,
    maxPhotoBytes: config.maxPhotoBytes,
    maxPhotos: config.maxPhotos,
    ownerTz,
  });

  // Expenditure & net energy (§ Expenditure & net energy, claude-assist#121).
  // Daily targets (§ Daily targets) parse once here at init — malformed config
  // throws and fails boot, never a silent drop.
  //
  // `stravaSyncHolder` exists because the StravaSync instance (built further
  // down, only when Strava is configured) doesn't exist yet at this
  // registration call — a plain indirection cell instead of reordering the
  // whole plugin body around the Strava block's credential gating.
  const stravaSyncHolder: { current?: StravaSync } = {};
  const expenditureStore = new PgExpenditureStore(fastify.sql);
  await fastify.register(registerExpenditureRoutes, {
    store: expenditureStore,
    entries: entryStore,
    tdeeBase: config.tdeeBase,
    dailyTargets: parseDailyTargets(config.dailyTargets),
    ownerTz,
    stravaSync: { getSkipped: () => stravaSyncHolder.current?.getSkipped() ?? [] },
  });

  // Weigh-ins (§ Weigh-ins — scale data via the capture app). Read-time
  // derivations only; nothing here (or anywhere) auto-tunes KITCHEN_TDEE_BASE
  // or the daily targets from the trend — that stays an owner/agent loop.
  await fastify.register(registerWeighInRoutes, {
    store: new PgWeighInStore(fastify.sql),
    ownerTz,
  });

  await fastify.register(registerInventoryRoutes, {
    inventory,
    maxPhotoBytes: config.maxPhotoBytes,
    maxPhotos: config.maxPhotos,
  });

  // Prep worksheets — build a collection surface from the catalog and publish
  // it through core's PagePublisher seam (§ Authoring a prep worksheet). Reads
  // the generic `fastify.pages` decorator at request time; 503s when absent.
  await fastify.register(registerPrepRoutes, {
    store: inventoryStore,
    recipes: recipeStore,
    resolveRecipe: resolveMergedRecipe,
  });

  // Plan-session — app-initiated warm meal-planning session. Reads the generic
  // `fastify.sessionSpawner` decorator (from the session-spawn module) at
  // request time; 503s when it's absent/unconfigured.
  await fastify.register(registerPlanSessionRoutes, {
    pipeline,
    inventory,
    model: config.planSessionModel,
  });

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

  // Cook-mode seam (§ Cook mode): submitting a prep worksheet IS the log. Lands
  // on the existing contracts — a directly-stated entry when eaten, a
  // conversion when packed — keyed on the submission's ULID for idempotency.
  fastify.decorate(
    'kitchenCookMode',
    new KitchenCookMode({
      entries: pipeline,
      inventory,
      // Eaten sheets decrement what they name (§ Eaten sheets decrement their
      // sources). Both verbs are existing inventory operations — no second
      // depletion implementation.
      depleter: {
        consumeStated: (itemUlid, input) => inventory.consumeStatedAmount(itemUlid, input),
        finishUnit: (itemUlid, input) =>
          inventory.applyEvent(itemUlid, 'finished-unit', input.at ? { at: input.at } : {}),
      },
    }) satisfies KitchenCookModeSurface
  );

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

  // Strava activity sync (§ Strava activity sync — the exercise auto-feed).
  // Cadence parses boot-loud even when the feature is off (same doctrine as
  // KITCHEN_DAILY_TARGETS: a malformed value fails startup, never a silent
  // drop). The feature itself gates on all three credentials being present —
  // any absent ⇒ entirely off, the task is never registered.
  const stravaSyncMinutes = parseStravaSyncMinutes(config.stravaSyncMinutes);
  if (!isStravaSyncConfigured(config)) {
    fastify.log.info('Strava sync off — KITCHEN_STRAVA_* credentials not fully configured');
  } else {
    // The client is constructed whenever the credentials exist, independently of
    // whether the expenditure SYNC is enabled: the read-only activity-history
    // seam below is a different consumer with a different kill switch, and
    // disabling the calorie sync should not also blind it.
    const stravaClient = new StravaClient(
      {
        clientId: config.stravaClientId!,
        clientSecret: config.stravaClientSecret!,
        refreshTokenSeed: config.stravaRefreshToken!,
      },
      new PgStravaOAuthStore(fastify.sql),
      fastify.log
    );

    // Activity-history seam: expose the read behind core's provider-agnostic
    // contract so a sibling module can consume history without holding a second
    // refresh token for the same OAuth app (see services/activity-history.ts).
    fastify.decorate('kitchenActivityHistory', createActivityHistoryProvider(stravaClient));

    if (config.disableStravaSync) {
      fastify.log.info('Strava expenditure sync disabled via config (activity history still readable)');
    } else {
      const stravaSync = new StravaSync(stravaClient, expenditureStore, fastify.log);
      stravaSyncHolder.current = stravaSync;
      fastify.scheduler.register({
        name: 'kitchen:strava-sync',
        schedule: stravaSyncCron(stravaSyncMinutes),
        runOnStartup: true, // first run backfills/replays the trailing week
        handler: async () => {
          const result = await stravaSync.tick();
          if (result.inserted > 0 || result.skipped_no_calories > 0) {
            fastify.log.info({ result }, 'Strava sync tick complete');
          }
        },
      });
      fastify.log.info({ minutes: stravaSyncMinutes }, 'Strava sync enabled');
    }
  }
});

// Re-exports for clients (tests, future modules, briefing source)
export * from './types.js';
export { generateUlid, ulidFromSeed, isValidUlid, ULID_PATTERN } from './ulid.js';
export { transition, InvalidTransitionError, type EntryEvent } from './state.js';
export {
  resolveOwnerTz,
  OwnerTzConfigError,
  offsetMinutes,
  localDay,
  subjectiveDay,
  localDisplay,
  formatOffset,
  localToday,
  type OwnerTz,
} from './zoned.js';
export {
  parseDailyTargets,
  DailyTargetsConfigError,
  DAILY_TARGET_FIELDS,
  type DailyTargets,
  type DailyTargetBound,
  type DailyTargetField,
} from './daily-targets.js';
export type { EntryStore, ExpenditureRecord, ExpenditureStore, NewEntry, NewExpenditure, NewRecipe, NewWeighIn, RecentEntrySummary, RecipeStore, StravaOAuthState, StravaOAuthStore, WeighInRecord, WeighInStore } from './store.js';
export { PgEntryStore, PgRecipeStore, PgStravaOAuthStore, PgWeighInStore, normalizeNewEntry, EMPTY_NUTRITION } from './store.js';
export { MemoryEntryStore, MemoryRecipeStore, MemoryStravaOAuthStore, MemoryWeighInStore } from './memory-store.js';
export {
  StravaClient,
  StravaRefreshError,
  StravaApiError,
  type StravaClientConfig,
  type StravaActivitySummary,
  type StravaActivityDetail,
  type FetchLike,
} from './services/strava-client.js';
export {
  createActivityHistoryProvider,
  toActivityRecord,
} from './services/activity-history.js';
export {
  StravaSync,
  StravaSyncConfigError,
  isStravaSyncConfigured,
  parseStravaSyncMinutes,
  stravaSyncCron,
  type StravaSyncTickResult,
  type StravaSkippedActivity,
} from './services/strava-sync.js';
export {
  registerWeighInRoutes,
  parseOffsetMinutes,
  localDateOf,
  median,
  collapseDaily,
  rollingTrend,
  type WeighInRoutesConfig,
  type DailyWeight,
  type TrendPoint,
} from './routes/weigh-ins.js';
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
  parsePackageCount,
} from './inventory-derive.js';
export {
  transitionInventory,
  isTerminal,
  InvalidTransitionError as InvalidInventoryTransitionError,
} from './inventory-state.js';
export { parseRemark, matchScore, type ParsedRemark } from './inventory-remark.js';
export {
  parseMeasure,
  measureToUnits,
  resolveUnitBasis,
  packagePriceCents,
  pricePoint,
  parseTossNotes,
  tossNoteLine,
  wasteCost,
  nearestPricedLine,
  type Measure,
  type PriceLine,
  type TossRecord,
} from './inventory-pricing.js';
export {
  PgInventoryStore,
  DEFAULT_ON_HAND_ITEM_STATES,
  type InventoryStore,
  type NewProduct,
  type NewItem,
  type NewBatch,
  type NewBatchLine,
  type NewLexicon,
  type NewDerivation,
} from './inventory-store.js';
export { MemoryInventoryStore } from './inventory-memory-store.js';
export {
  InventoryPipeline,
  LabelParserUnavailableError,
  NotCountedItemError,
  normalizeLine,
  candidateStrings,
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
export { registerPrepRoutes, type PrepRoutesConfig } from './routes/prep.js';
export { PrepService, PrepValidationError, plannedTotals, PREP_FIELDS, type PrepPublishInput, type PrepPublishResult } from './services/prep.js';
