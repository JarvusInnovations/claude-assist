/**
 * Training module — the weekly adaptive training loop.
 *
 * Two schedules and one gate:
 *
 *   1. `training:weekly-plan` — once a week, synthesize the coming week from
 *      activity history, the forecast, and calendar availability; store it as
 *      `proposed`; raise one approval; return. Heartbeat: `training-plan`.
 *   2. `training:reconcile` — a short-cadence pass that settles proposals whose
 *      gate has been answered (or has expired unanswered).
 *
 * The day's session renders into the daily briefing through the briefing
 * module's own source, which reads `training.week_plans` directly — the
 * sibling-schema pattern its other sources use, so the two packages don't
 * cycle even though training reads briefing's calendar boundary.
 *
 * Everything degrades: no metered-model credential ⇒ the weekly job preflights
 * and exits clean; no forecast credentials ⇒ the week is planned without one
 * and the synthesis is told so; no approvals module ⇒ the week activates with
 * a loud warning rather than being unreachable forever.
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import {
  createPlugin,
  type ApprovalService,
  type HeartbeatRegistry,
  type ModelInvoker,
  type NotifyDispatcher,
  type PluginOptions,
  type Scheduler,
  type TrainingPluginConfig,
} from '@jarvus/claude-assist-core';
import { PgWeekPlanStore } from './store.js';
import { ModelWeekPlanner } from './services/planner.js';
import { WeatherClient, isWeatherConfigured } from './sources/weather.js';
import { registerTrainingRoutes } from './routes.js';
import {
  TRAINING_PIPELINE,
  reconcileProposals,
  runWeeklyPlanning,
  type WeeklyPlanningDeps,
} from './runner.js';

declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
    notify?: NotifyDispatcher;
    heartbeats?: HeartbeatRegistry;
    invoker?: ModelInvoker;
    approvals?: ApprovalService;
  }
}

/**
 * Where the owner trains is instance data, so the toolkit picks the only zone
 * that is nobody's home: UTC. An unset TRAINING_TIMEZONE means the plan week
 * is a UTC week — correct, and obviously wrong to anyone who meant a local one.
 */
const DEFAULT_TIMEZONE = 'UTC';

/** Sunday morning: the coming week is proposed before it starts. */
const DEFAULT_PLAN_CRON = '0 7 * * 0';
const DEFAULT_RECONCILE_CRON = '*/10 * * * *';

/**
 * A week plus slack. Tight enough that one skipped weekly generation pages,
 * loose enough that a run delayed by a restart doesn't.
 */
const DEFAULT_STALE_AFTER = '9 days';

export default createPlugin('training', async (fastify: FastifyInstance, options: PluginOptions) => {
  const config: TrainingPluginConfig = options.trainingConfig ?? {};
  const timeZone = config.timeZone ?? DEFAULT_TIMEZONE;
  if (!config.timeZone) {
    fastify.log.warn('TRAINING_TIMEZONE unset — the plan week is a UTC week');
  }

  const store = new PgWeekPlanStore(fastify.sql);

  // Planner (optional — requires the metered-model invoker). Without it the
  // weekly job preflights and exits clean; there is no deterministic fallback
  // plan, because an unconsidered week proposed for approval would look exactly
  // like a considered one.
  const planner = fastify.invoker?.enabled
    ? new ModelWeekPlanner(
        {
          invoker: fastify.invoker,
          ...(config.plannerModel ? { model: config.plannerModel } : {}),
          ...(config.goalContext ? { goalContext: config.goalContext } : {}),
        },
        fastify.log
      )
    : null;
  if (!planner) {
    fastify.log.warn('Training: model invoker unavailable — weekly plan generation is off');
  }

  // Forecast (optional). Both credentials are instance config; either absent
  // and the client is never constructed.
  const weather = isWeatherConfigured({
    ...(config.weatherApiKey ? { apiKey: config.weatherApiKey } : {}),
    ...(config.weatherLocationKey ? { locationKey: config.weatherLocationKey } : {}),
  })
    ? new WeatherClient(
        {
          apiKey: config.weatherApiKey!,
          locationKey: config.weatherLocationKey!,
          ...(config.weatherBaseUrl ? { baseUrl: config.weatherBaseUrl } : {}),
          ...(config.weatherDays ? { days: config.weatherDays } : {}),
        },
        fastify.log
      )
    : null;
  if (!weather) {
    fastify.log.info(
      'Training: TRAINING_WEATHER_API_KEY/TRAINING_WEATHER_LOCATION_KEY not set — planning without a forecast'
    );
  }

  if (!config.activityHistoryProvider) {
    fastify.log.info('Training: no activity-history provider wired — planning without recent activity');
  }

  const planningDeps = (): WeeklyPlanningDeps => ({
    store,
    planner,
    approvals: fastify.approvals,
    log: fastify.log,
    timeZone,
    weather,
    ...(config.activityHistoryProvider
      ? { activityHistory: config.activityHistoryProvider }
      : {}),
    ...(config.activityWindowDays ? { activityWindowDays: config.activityWindowDays } : {}),
    ...(config.gwsAxiBin ? { gwsAxiBin: config.gwsAxiBin } : {}),
    ...(config.calendarAccount ? { calendarAccount: config.calendarAccount } : {}),
  });

  await fastify.register(registerTrainingRoutes, { store, timeZone, planningDeps });

  const staleAfter = config.staleAfter ?? DEFAULT_STALE_AFTER;

  // Registered up-front so a generation that never happens pages, rather than
  // an unknown pipeline staying invisible until its first success.
  if (!config.disablePlanning) {
    await fastify.heartbeats?.register({ name: TRAINING_PIPELINE, threshold: staleAfter });
  }

  if (!config.disablePlanning) {
    fastify.scheduler.register({
      name: 'training:weekly-plan',
      schedule: config.planCron ?? DEFAULT_PLAN_CRON,
      timezone: timeZone,
      runOnStartup: false,
      handler: async () => {
        const result = await runWeeklyPlanning(planningDeps());
        fastify.log.info({ ...result }, 'Training: weekly planning complete');
        // Beat only on a run that actually produced or found a week. A preflight
        // exit is a real gap in coverage and must page, not be papered over.
        if (result.outcome !== 'skipped_no_planner') {
          await fastify.heartbeats?.beat(TRAINING_PIPELINE, { threshold: staleAfter });
        }
      },
    });
  } else {
    fastify.log.info('Training: weekly plan generation disabled via config');
  }

  fastify.scheduler.register({
    name: 'training:reconcile',
    schedule: config.reconcileCron ?? DEFAULT_RECONCILE_CRON,
    runOnStartup: true,
    handler: async () => {
      const result = await reconcileProposals({
        store,
        approvals: fastify.approvals,
        log: fastify.log,
      });
      if (result.activated > 0 || result.rejected > 0 || result.expired > 0) {
        fastify.log.info({ ...result }, 'Training: proposals reconciled');
      }
    },
  });

  fastify.log.info('Training module loaded (weekly plan generation + async approval)');
});

// Re-exports for tests + external use.
export * from './types.js';
export {
  addDays,
  daysBetween,
  isIsoDate,
  isoWeekday,
  nextWeekStart,
  todayIsoInTz,
  tzOffsetMinutes,
  weekDates,
  weekEndOf,
  weekStartOf,
  weekWindowIso,
  weekdayName,
  zonedMidnightIso,
} from './week.js';
export {
  PLAN_TAG,
  SESSION_KINDS,
  SESSION_VENUES,
  SYSTEM_PROMPT,
  buildPlanPrompt,
  parseWeek,
} from './compose.js';
export {
  PgWeekPlanStore,
  type NewWeekPlan,
  type WeekPlanStore,
} from './store.js';
export { MemoryWeekPlanStore } from './memory-store.js';
export {
  fetchActivitySummary,
  isRun,
  normalizeSport,
  summarizeActivities,
} from './sources/activity.js';
export {
  WeatherClient,
  isWeatherConfigured,
  parseDailyForecast,
  type FetchLike,
  type WeatherClientConfig,
} from './sources/weather.js';
export {
  fetchAvailability,
  summarizeAvailability,
  type AvailabilityOptions,
  type EventsFetcher,
} from './sources/availability.js';
export {
  ModelWeekPlanner,
  PLAN_TASK,
  type PlannerConfig,
  type WeekPlanner,
} from './services/planner.js';
export {
  APPROVAL_KIND,
  TRAINING_PIPELINE,
  approvalKeyFor,
  reconcileProposals,
  runWeeklyPlanning,
  type ReconcileResult,
  type WeeklyPlanningDeps,
  type WeeklyPlanningResult,
} from './runner.js';
export { registerTrainingRoutes, type TrainingRoutesConfig } from './routes.js';
