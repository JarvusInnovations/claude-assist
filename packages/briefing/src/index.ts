/**
 * Briefing module — two tightly-related scheduled pipelines that share one
 * calendar-read path and one join-required classifier:
 *
 *   1. Daily briefing — a morning job that composes today's briefing (calendar +
 *      alert plan, open commitments, urgent email, captures, coverage) and renders
 *      it into the Tana day node, then dispatches a `notice` ping. Heartbeat:
 *      `daily-briefing`.
 *
 *   2. Meeting alerts — a frequent cycle that classifies upcoming events and
 *      fires exactly one `interrupt` per join-required meeting at its lead time,
 *      deduped so restarts never double-fire. Heartbeat: `meeting-alerts`.
 *
 * Both degrade gracefully: no Anthropic key → deterministic-only classifier; no
 * Tana → briefing composed but not rendered; missing gws-axi or commitments
 * source → those sections flag "not available" instead of failing.
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import {
  createPlugin,
  TanaMcpClient,
  type PluginOptions,
  type Scheduler,
  type NotifyDispatcher,
  type HeartbeatRegistry,
} from '@jarvus/claude-assist-core';
import { PgOverrideStore } from './alerts/overrides.js';
import { PgDispatchLedger } from './alerts/dispatch-ledger.js';
import { PlanProvider } from './alerts/plan-provider.js';
import { runAlertCycle } from './alerts/scheduler.js';
import { registerBriefingRoutes } from './alerts/routes.js';
import { JoinRequiredModel } from './classifier/llm.js';
import { BriefingRenderer } from './briefing/render.js';
import { runDailyBriefing } from './briefing/runner.js';

// Module augmentation for fastify decorators
declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
    notify?: NotifyDispatcher;
    heartbeats?: HeartbeatRegistry;
  }
}

export const DAILY_BRIEFING_PIPELINE = 'daily-briefing';
export const MEETING_ALERTS_PIPELINE = 'meeting-alerts';

const DEFAULT_TIMEZONE = 'America/New_York';

export default createPlugin('briefing', async (fastify: FastifyInstance, options: PluginOptions) => {
  const config = options.briefingConfig ?? {};
  const timeZone = config.timeZone ?? DEFAULT_TIMEZONE;

  // --- Join-required residue model (optional) --------------------------------
  const model = config.anthropicApiKey
    ? new JoinRequiredModel(
        { apiKey: config.anthropicApiKey, model: config.classifierModel },
        fastify.log
      )
    : null;
  if (!model) {
    fastify.log.warn('Briefing: anthropicApiKey not set — join classifier is deterministic-only');
  }

  // --- Shared stores + plan provider -----------------------------------------
  const overrides = new PgOverrideStore(fastify.sql);
  const ledger = new PgDispatchLedger(fastify.sql);
  const planProvider = new PlanProvider({
    overrides,
    model,
    log: fastify.log,
    timeZone,
    gwsBin: config.gwsAxiBin,
    account: config.calendarAccount,
  });

  await fastify.register(registerBriefingRoutes, { overrides, planProvider });

  // --- Tana renderer (optional) ----------------------------------------------
  let renderer: BriefingRenderer | null = null;
  if (config.tanaMcpToken && config.tanaWorkspaceId) {
    const tanaClient = new TanaMcpClient({
      url: config.tanaMcpUrl ?? 'http://127.0.0.1:8262/mcp',
      token: config.tanaMcpToken,
      clientName: 'claude-assist-briefing',
    });
    renderer = new BriefingRenderer(tanaClient, config.tanaWorkspaceId, fastify.log);
  } else {
    fastify.log.warn(
      'Briefing: TANA_MCP_TOKEN/TANA_WORKSPACE_ID not set — briefing will compose but not render'
    );
  }

  // --- Heartbeats: register up-front so absence pages even before first run ---
  await fastify.heartbeats?.register({ name: DAILY_BRIEFING_PIPELINE, threshold: '25 hours' });
  await fastify.heartbeats?.register({ name: MEETING_ALERTS_PIPELINE, threshold: '1 hour' });

  // --- Pipeline 1: morning briefing ------------------------------------------
  if (!config.disableBriefing) {
    fastify.scheduler.register({
      name: 'briefing:daily',
      schedule: config.briefingCron ?? '30 6 * * *',
      timezone: timeZone,
      runOnStartup: false,
      handler: async () => {
        const result = await runDailyBriefing({
          sql: fastify.sql,
          planProvider,
          renderer,
          notify: fastify.notify,
          log: fastify.log,
          timeZone,
          commitmentsBin: config.commitmentsBin,
          commitmentsArgs: config.commitmentsArgs,
          pageBaseUrl: config.pageBaseUrl ?? null,
        });
        fastify.log.info(
          { rendered: result.rendered, notified: result.notified, date: result.briefing.dateIso },
          'Daily briefing complete'
        );
        await fastify.heartbeats?.beat(DAILY_BRIEFING_PIPELINE, { threshold: '25 hours' });
      },
    });
  } else {
    fastify.log.info('Briefing: daily briefing schedule disabled via config');
  }

  // --- Pipeline 2: meeting alerts --------------------------------------------
  if (!config.disableAlerts) {
    const windowMinutes = config.alertWindowMinutes ?? 60;
    fastify.scheduler.register({
      name: 'briefing:alerts',
      schedule: config.alertCron ?? '*/2 * * * *',
      runOnStartup: true,
      handler: async () => {
        const now = Date.now();
        const fromIso = new Date(now - 5 * 60_000).toISOString();
        const toIso = new Date(now + windowMinutes * 60_000).toISOString();
        const plan = await planProvider.planForWindow(fromIso, toIso);

        const result = await runAlertCycle({
          events: plan.items.map((item) => item.event),
          overrides: await overrides.getMany([
            ...new Set(plan.items.map((item) => item.event.seriesId)),
          ]),
          model,
          ledger,
          notify: fastify.notify,
          log: fastify.log,
          nowMs: now,
        });
        if (result.fired > 0 || result.due > 0) {
          fastify.log.info({ ...result, calendarError: plan.calendarError }, 'Alert cycle complete');
        }
        // The cycle beats every evaluation so a stalled scheduler pages even on a
        // meeting-heavy day (coverage-watermarks: alert on absence of success).
        await fastify.heartbeats?.beat(MEETING_ALERTS_PIPELINE, { threshold: '1 hour' });
      },
    });
  } else {
    fastify.log.info('Briefing: meeting-alert schedule disabled via config');
  }

  fastify.log.info('Briefing module loaded (daily briefing + meeting alerts)');
});

// Re-exports for tests + external use.
export * from './types.js';
export {
  parseEventsToon,
  parseAttendeeCount,
  stripInstanceSuffix,
  isDateOnly,
  fetchEvents,
  type CalendarReadResult,
} from './calendar/gws-axi.js';
export { parseToonTable, parseCsvRow, rowRecord } from './toon.js';
export {
  classifyEvent,
  isAmbiguous,
  leadMinutesFor,
  detectVenue,
  matchNoisePattern,
  hasPhysicalLocation,
  locationHasUrl,
  DEFAULT_VIDEO_LEAD_MINUTES,
  DEFAULT_PHYSICAL_LEAD_MINUTES,
} from './classifier/join-required.js';
export { JoinRequiredModel, parseJoin, buildPrompt } from './classifier/llm.js';
export { resolveAlertPlan, alertingItems, computeFireAtMs } from './alerts/plan.js';
export { PgOverrideStore, MemoryOverrideStore, type OverrideStore } from './alerts/overrides.js';
export {
  PgDispatchLedger,
  MemoryDispatchLedger,
  type DispatchLedger,
} from './alerts/dispatch-ledger.js';
export { runAlertCycle, isDue, alertTitle, alertBody, FIRE_GRACE_MS } from './alerts/scheduler.js';
export { PlanProvider, type CalendarFetcher, type DayPlan } from './alerts/plan-provider.js';
export { registerBriefingRoutes, type BriefingRoutesConfig } from './alerts/routes.js';
export { composeBriefing, buildHeadline, type Briefing, type BriefingInputs } from './briefing/compose.js';
export {
  renderTanaPaste,
  BriefingRenderer,
  extractNodeId,
  briefingHeading,
  BRIEFING_MARKER,
} from './briefing/render.js';
export { runDailyBriefing, dayNodeLink, type BriefingRunResult } from './briefing/runner.js';
export {
  fetchOpenCommitments,
  parseCommitments,
  type OpenCommitment,
} from './briefing/sources/commitments.js';
export { fetchEmailSummary, type EmailSummary } from './briefing/sources/email.js';
export { fetchCapturesSummary, type CapturesSummary } from './briefing/sources/captures.js';
export { fetchCoverageSummary, type CoverageSummary } from './briefing/sources/coverage.js';
export {
  todayIsoInTz,
  zonedDayWindow,
  zonedDayStartMs,
  tzOffsetMinutes,
} from './time.js';
