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
import { PgMeetingPrepStore } from './meetings/prep-store.js';
import { AnthropicPrepComposer } from './meetings/model.js';
import { MeetingPrepRenderer } from './meetings/render.js';
import { runMeetingCycle } from './meetings/cycle.js';

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
export const MEETING_BRIEFINGS_PIPELINE = 'meeting-briefings';

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
  // Shared by the meeting-briefing cycle (writes) and the alert cycle (reads a
  // delivered prep's Tana node id to link it from the alert).
  const prepStore = new PgMeetingPrepStore(fastify.sql);
  const planProvider = new PlanProvider({
    overrides,
    model,
    log: fastify.log,
    timeZone,
    gwsBin: config.gwsAxiBin,
    account: config.calendarAccount,
  });

  await fastify.register(registerBriefingRoutes, { overrides, planProvider });

  // --- Tana renderers (optional) ---------------------------------------------
  let renderer: BriefingRenderer | null = null;
  let meetingRenderer: MeetingPrepRenderer | null = null;
  if (config.tanaMcpToken && config.tanaWorkspaceId) {
    const tanaClient = new TanaMcpClient({
      url: config.tanaMcpUrl ?? 'http://127.0.0.1:8262/mcp',
      token: config.tanaMcpToken,
      clientName: 'claude-assist-briefing',
    });
    renderer = new BriefingRenderer(tanaClient, config.tanaWorkspaceId, fastify.log);
    meetingRenderer = new MeetingPrepRenderer(tanaClient, config.tanaWorkspaceId, fastify.log);
  } else {
    fastify.log.warn(
      'Briefing: TANA_MCP_TOKEN/TANA_WORKSPACE_ID not set — briefing will compose but not render'
    );
  }

  // --- Meeting-prep composer (optional; Sonnet-class single invoker) ----------
  const prepComposer = config.anthropicApiKey
    ? new AnthropicPrepComposer(
        { apiKey: config.anthropicApiKey, model: config.meetingPrepModel },
        fastify.log
      )
    : null;
  if (!prepComposer) {
    fastify.log.warn('Briefing: anthropicApiKey not set — meeting preps use the deterministic composer');
  }

  // --- Heartbeats: register up-front so absence pages even before first run ---
  await fastify.heartbeats?.register({ name: DAILY_BRIEFING_PIPELINE, threshold: '25 hours' });
  await fastify.heartbeats?.register({ name: MEETING_ALERTS_PIPELINE, threshold: '1 hour' });
  if (!config.disableMeetingBriefings) {
    await fastify.heartbeats?.register({ name: MEETING_BRIEFINGS_PIPELINE, threshold: '2 hours' });
  }

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
          kitchenRecipesProvider: config.kitchenRecipesProvider,
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
      // Every minute: the shortest lead (1 min) makes a due window of only
      // ~60s + started-grace, which a 2-minute cadence can skip entirely.
      schedule: config.alertCron ?? '* * * * *',
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
          prepStore,
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

  // --- Pipeline 3: per-meeting briefings (preps) -----------------------------
  if (!config.disableMeetingBriefings) {
    fastify.scheduler.register({
      name: 'briefing:meetings',
      schedule: config.meetingCron ?? '*/30 * * * *',
      runOnStartup: false,
      handler: async () => {
        const result = await runMeetingCycle({
          prepStore,
          planProvider,
          sql: fastify.sql,
          composer: prepComposer,
          renderer: meetingRenderer,
          log: fastify.log,
          nowMs: Date.now(),
          gwsBin: config.gwsAxiBin,
          account: config.calendarAccount,
          contextBin: config.meetingContextBin,
          contextArgs: config.meetingContextArgs,
          refreshAheadHours: config.meetingRefreshAheadHours,
          pageBaseUrl: config.pageBaseUrl ?? null,
        });
        if (result.generated > 0 || result.refreshed > 0 || result.calendarError) {
          fastify.log.info({ ...result }, 'Meeting-briefing cycle complete');
        }
        await fastify.heartbeats?.beat(MEETING_BRIEFINGS_PIPELINE, { threshold: '2 hours' });
      },
    });
  } else {
    fastify.log.info('Briefing: per-meeting briefing cycle disabled via config');
  }

  fastify.log.info('Briefing module loaded (daily briefing + meeting alerts + per-meeting briefings)');
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
export { decodeToonRows, sliceNamedBlock } from './toon.js';
export {
  classifyEvent,
  isAmbiguous,
  leadMinutesFor,
  detectVenue,
  matchNoisePattern,
  hasPhysicalLocation,
  locationHasUrl,
  locationIsConferencingName,
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
export {
  runAlertCycle,
  isDue,
  alertTitle,
  alertBody,
  buildAlertPayload,
  prepNodeLink,
  FIRE_GRACE_MS,
} from './alerts/scheduler.js';
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
  fetchLedgerNarrative,
  groupLedgerActions,
  type LedgerActionRow,
  type LedgerActionGroup,
  type LedgerNarrative,
} from './briefing/sources/ledger.js';
export {
  todayIsoInTz,
  zonedDayWindow,
  zonedDayStartMs,
  tzOffsetMinutes,
  priorDateIso,
} from './time.js';

// --- Per-meeting briefings (preps) -------------------------------------------
export type {
  MeetingPrep,
  MeetingPrepStatus,
  OccurrenceIdentity,
} from './meetings/types.js';
export {
  occurrenceIdentity,
  occurrenceEndMs,
  nextOccurrence,
  decodeOriginalStart,
} from './meetings/occurrence.js';
export {
  PgMeetingPrepStore,
  MemoryMeetingPrepStore,
  type MeetingPrepStore,
  type PrepUpsert,
} from './meetings/prep-store.js';
export {
  fetchMeetingContext,
  type MeetingContextRequest,
  type MeetingContextResult,
} from './meetings/context-source.js';
export {
  fetchMeetingCaptures,
  meetingTag,
  type MeetingCapture,
  type MeetingCapturesResult,
} from './meetings/captures-source.js';
export {
  inputsDigest,
  buildPrepPrompt,
  deterministicPrep,
  type PrepInputs,
} from './meetings/compose.js';
export { AnthropicPrepComposer, normalizeBullets, type PrepComposer } from './meetings/model.js';
export {
  MeetingPrepRenderer,
  renderPrepPaste,
  prepHeading,
  prepDateIso,
  findChildIdByHeading,
  PREP_MARKER,
} from './meetings/render.js';
export {
  runMeetingCycle,
  generateNextPrep,
  buildAndStorePrep,
  type MeetingCycleDeps,
  type MeetingCycleResult,
} from './meetings/cycle.js';
