/**
 * The two scheduled halves of the training loop.
 *
 *  1. `runWeeklyPlanning` — once a week, synthesize the coming week from
 *     activity history + forecast + calendar availability, store it as
 *     `proposed`, raise ONE approval gate, and return.
 *  2. `reconcileProposals` — on a short cadence, ask the approvals module what
 *     happened to the gates already raised, and settle the plans accordingly.
 *
 * The split is the whole design. **Nothing here ever waits for a human**
 * (specs/modules/approvals.md § escalation-as-abort): the weekly job records
 * that it asked and exits, so a plan nobody looks at for three days costs one
 * pending row, not a held lease, a stalled scheduler, or a daily chore. A human
 * who never answers gets the same outcome as one who says no — the approval
 * expires, the plan closes, and staleness pages on the missing week.
 */

import type { FastifyBaseLogger } from 'fastify';
import type {
  ActivityHistoryProvider,
  ApprovalService,
  ModelInvoker,
} from '@jarvus/claude-assist-core';
import type { WeekPlanStore } from './store.js';
import type { PlanInputs, WeekPlan } from './types.js';
import type { WeekPlanner } from './services/planner.js';
import type { WeatherClient } from './sources/weather.js';
import { fetchActivitySummary } from './sources/activity.js';
import { fetchAvailability, type EventsFetcher } from './sources/availability.js';
import { addDays, nextWeekStart, todayIsoInTz, weekDates, weekEndOf } from './week.js';

export const TRAINING_PIPELINE = 'training-plan';
export const APPROVAL_KIND = 'training_week_plan';

/** Stable per-week key: one pending gate per week, however often the job runs. */
export function approvalKeyFor(weekStart: string): string {
  return `training:week:${weekStart}`;
}

export interface WeeklyPlanningDeps {
  store: WeekPlanStore;
  planner: WeekPlanner | null;
  approvals: ApprovalService | undefined;
  log: FastifyBaseLogger;
  timeZone: string;
  /** Generic activity-history seam; absent ⇒ planned without history. */
  activityHistory?: ActivityHistoryProvider;
  /** Constructed only when the forecast credentials are present. */
  weather: WeatherClient | null;
  gwsAxiBin?: string;
  calendarAccount?: string;
  /** Injection seam for tests. */
  eventsFetcher?: EventsFetcher;
  activityWindowDays?: number;
  /** Plan this week instead of the next one (manual regeneration). */
  weekStart?: string;
  now?: Date;
}

export type WeeklyPlanningOutcome =
  | 'proposed'
  | 'auto_activated'
  | 'already_pending'
  | 'skipped_no_planner';

export interface WeeklyPlanningResult {
  weekStart: string;
  outcome: WeeklyPlanningOutcome;
  planId: string | null;
  approvalId: string | null;
  /** Which inputs came back unusable — logged, and visible in the stored plan. */
  degraded: string[];
}

export async function runWeeklyPlanning(
  deps: WeeklyPlanningDeps
): Promise<WeeklyPlanningResult> {
  const today = todayIsoInTz(deps.timeZone, deps.now ?? new Date());
  const weekStart = deps.weekStart ?? nextWeekStart(today);

  // PREFLIGHT. No metered-model credential ⇒ nothing to synthesize with. Exit
  // clean rather than half-writing a plan: an empty week proposed for approval
  // would be indistinguishable from a considered one.
  if (!deps.planner) {
    deps.log.warn(
      { weekStart },
      'Training: model invoker unavailable — weekly plan generation skipped'
    );
    return { weekStart, outcome: 'skipped_no_planner', planId: null, approvalId: null, degraded: [] };
  }

  // Idempotence: a re-run (a manual trigger, a restart's startup pass) must not
  // stack a second proposal on a week that already has one open.
  const pending = await deps.store.byWeek(weekStart, 'proposed');
  if (pending) {
    deps.log.info({ weekStart, plan: pending.id }, 'Training: a proposal is already pending for the week');
    return {
      weekStart,
      outcome: 'already_pending',
      planId: pending.id,
      approvalId: pending.approvalId,
      degraded: [],
    };
  }

  const inputs = await gatherInputs(deps, weekStart);
  const degraded = degradedSources(inputs);
  if (degraded.length > 0) {
    deps.log.warn({ weekStart, degraded }, 'Training: planning with degraded inputs');
  }

  const week = await deps.planner.synthesize(inputs);

  const stored = await deps.store.insertProposed({
    weekStart,
    summary: week.summary,
    rationale: week.rationale,
    adjustments: week.adjustments,
    sessions: week.sessions,
    inputs,
    model: deps.planner.modelId,
    approvalKey: approvalKeyFor(weekStart),
  });
  if (!stored) {
    // Lost a race with a concurrent run; the other one owns the gate.
    deps.log.info({ weekStart }, 'Training: proposal already inserted by a concurrent run');
    const existing = await deps.store.byWeek(weekStart, 'proposed');
    return {
      weekStart,
      outcome: 'already_pending',
      planId: existing?.id ?? null,
      approvalId: existing?.approvalId ?? null,
      degraded,
    };
  }

  // No approvals module ⇒ there is no way for a human to ever open this gate.
  // Activating is the honest degradation (the alternative is a plan that can
  // never render), and it is logged loudly because it is a weaker posture than
  // the design calls for.
  if (!deps.approvals) {
    await deps.store.activate(stored.id);
    deps.log.warn(
      { weekStart, plan: stored.id },
      'Training: approvals module unavailable — week activated without a human gate'
    );
    return { weekStart, outcome: 'auto_activated', planId: stored.id, approvalId: null, degraded };
  }

  const record = await deps.approvals.request({
    kind: APPROVAL_KIND,
    requestedBy: 'training.weekly-plan',
    title: `Training week of ${weekStart}: ${week.summary}`,
    body: approvalBody(week.adjustments, week.rationale, degraded),
    dedupeKey: approvalKeyFor(weekStart),
    payload: { planId: stored.id, weekStart, sessions: stored.sessions.length },
    // A training week is not an interrupt. It waits for the next time the owner
    // looks at their phone, which is precisely the point of the async loop.
    // No `url` — the approvals module builds the per-request review link from
    // its own configured base, so the deep link can't drift out of sync here.
    priority: 'notice',
  });
  await deps.store.attachApproval(stored.id, record.id);

  deps.log.info(
    { weekStart, plan: stored.id, approval: record.id, sessions: stored.sessions.length },
    'Training: week proposed for approval'
  );
  return { weekStart, outcome: 'proposed', planId: stored.id, approvalId: record.id, degraded };
}

function approvalBody(adjustments: string[], rationale: string, degraded: string[]): string {
  const parts: string[] = [];
  if (adjustments.length > 0) {
    parts.push(adjustments.map((a) => `• ${a}`).join('\n'));
  } else {
    parts.push(rationale);
  }
  if (degraded.length > 0) parts.push(`(planned without: ${degraded.join(', ')})`);
  return parts.join('\n\n');
}

function degradedSources(inputs: PlanInputs): string[] {
  const out: string[] = [];
  if (inputs.activity.error) out.push('activity history');
  if (inputs.weather.error) out.push('forecast');
  if (inputs.availability.error) out.push('calendar');
  return out;
}

async function gatherInputs(deps: WeeklyPlanningDeps, weekStart: string): Promise<PlanInputs> {
  const dates = weekDates(weekStart);

  // Every source degrades to a flagged error rather than throwing, so one
  // outage never sinks the week (the same contract the briefing's sources hold).
  const [activity, weather, availability, priorPlan] = await Promise.all([
    fetchActivitySummary(deps.activityHistory, {
      asOfIso: weekStart,
      ...(deps.activityWindowDays ? { windowDays: deps.activityWindowDays } : {}),
    }),
    deps.weather
      ? deps.weather.forecast(dates)
      : Promise.resolve({ days: [], error: 'forecast not configured' as string | null }),
    fetchAvailability(
      {
        weekStart,
        timeZone: deps.timeZone,
        ...(deps.gwsAxiBin ? { bin: deps.gwsAxiBin } : {}),
        ...(deps.calendarAccount ? { account: deps.calendarAccount } : {}),
      },
      deps.eventsFetcher
    ),
    deps.store.activeForDate(addDays(weekStart, -1)),
  ]);

  return {
    weekStart,
    weekEnd: weekEndOf(weekStart),
    activity,
    weather,
    availability,
    priorWeek: priorPlan
      ? { weekStart: priorPlan.weekStart, summary: priorPlan.summary, sessions: priorPlan.sessions }
      : null,
  };
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export interface ReconcileDeps {
  store: WeekPlanStore;
  approvals: ApprovalService | undefined;
  log: FastifyBaseLogger;
}

export interface ReconcileResult {
  checked: number;
  activated: number;
  rejected: number;
  expired: number;
}

/**
 * Settle proposals whose gate has been answered.
 *
 * This is the "later pass" half of escalation-as-abort: the requester learns
 * its gate opened by asking, on its own schedule, never by waiting. A gate that
 * expired unanswered closes the plan too — an approval nobody ever resolves
 * must fail closed rather than leave a proposal pending forever.
 */
export async function reconcileProposals(deps: ReconcileDeps): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, activated: 0, rejected: 0, expired: 0 };
  if (!deps.approvals) return result;

  const proposals = await deps.store.listProposed();
  for (const plan of proposals) {
    result.checked += 1;
    const record = await lookupApproval(deps.approvals, plan);
    if (!record) continue;

    switch (record.status) {
      case 'approved': {
        const activated = await deps.store.activate(plan.id);
        if (activated) {
          result.activated += 1;
          deps.log.info(
            { weekStart: plan.weekStart, plan: plan.id, approval: record.id },
            'Training: week approved and active'
          );
        }
        break;
      }
      case 'denied':
        await deps.store.close(plan.id, 'rejected');
        result.rejected += 1;
        deps.log.info(
          { weekStart: plan.weekStart, plan: plan.id },
          'Training: proposed week declined — the previous week stands'
        );
        break;
      case 'expired':
      case 'cancelled':
        await deps.store.close(plan.id, 'expired');
        result.expired += 1;
        deps.log.warn(
          { weekStart: plan.weekStart, plan: plan.id, status: record.status },
          'Training: proposed week was never answered — closed'
        );
        break;
      default:
        break; // still pending
    }
  }
  return result;
}

async function lookupApproval(approvals: ApprovalService, plan: WeekPlan) {
  if (plan.approvalId) {
    const byId = await approvals.get(plan.approvalId);
    if (byId) return byId;
  }
  // A proposal whose approval id never landed (a crash between the two writes)
  // is still findable by its dedupe key.
  return plan.approvalKey ? approvals.findResolved(plan.approvalKey) : null;
}
