/**
 * Daily-briefing runner — the scheduled orchestration.
 *
 * Gathers every content-contract section (calendar + alert plan from the shared
 * PlanProvider, open commitments, urgent email, captures, coverage), composes the
 * briefing, renders it into the Tana day node (when Tana is configured), and
 * dispatches a `notice`-priority ping whose title is the 2–3 headline items and
 * whose link points at the day node. Each section degrades independently; a
 * single failed source never sinks the whole briefing.
 */

import type { FastifyBaseLogger } from 'fastify';
import type postgres from 'postgres';
import type { NotifyDispatcher } from '@jarvus/claude-assist-core';
import type { PlanProvider } from '../alerts/plan-provider.js';
import type { BriefingRenderer } from './render.js';
import { composeBriefing, type Briefing } from './compose.js';
import { fetchOpenCommitments } from './sources/commitments.js';
import { fetchEmailSummary } from './sources/email.js';
import { fetchCapturesSummary } from './sources/captures.js';
import { fetchCoverageSummary } from './sources/coverage.js';

export interface BriefingRunnerDeps {
  sql: postgres.Sql;
  planProvider: PlanProvider;
  renderer: BriefingRenderer | null;
  notify: NotifyDispatcher | undefined;
  log: FastifyBaseLogger;
  timeZone: string;
  commitmentsBin?: string;
  commitmentsArgs?: string[];
  pageBaseUrl?: string | null;
}

export interface BriefingRunResult {
  briefing: Briefing;
  dayNodeId: string | null;
  rendered: boolean;
  notified: boolean;
}

export async function runDailyBriefing(deps: BriefingRunnerDeps): Promise<BriefingRunResult> {
  const dayPlan = await deps.planProvider.planForDate();
  const dateIso = dayPlan.dateIso;

  // Gather the remaining sources in parallel; each returns a flagged error
  // rather than throwing, so one outage doesn't sink the briefing.
  const [commitments, email, captures, coverage] = await Promise.all([
    fetchOpenCommitments({ bin: deps.commitmentsBin, args: deps.commitmentsArgs, todayIso: dateIso }),
    fetchEmailSummary(deps.sql),
    fetchCapturesSummary(deps.sql),
    fetchCoverageSummary(deps.sql),
  ]);

  const events = dayPlan.items.map((item) => item.event);
  const briefing = composeBriefing({
    dateIso,
    calendar: { events, error: dayPlan.calendarError },
    alertPlan: dayPlan.items,
    commitments,
    email,
    captures,
    coverage,
    pageBaseUrl: deps.pageBaseUrl ?? null,
  });

  // Render into the Tana day node (the briefing's surface).
  let dayNodeId: string | null = null;
  let rendered = false;
  if (deps.renderer) {
    try {
      const result = await deps.renderer.render(briefing);
      dayNodeId = result.dayNodeId;
      rendered = result.imported;
    } catch (err) {
      deps.log.error({ err }, 'Briefing render into Tana failed');
    }
  } else {
    deps.log.warn('Tana not configured — briefing composed but not rendered into a day node');
  }

  // Dispatch the "briefing ready" ping through the one dispatcher.
  let notified = false;
  if (deps.notify) {
    const url = dayNodeLink(dayNodeId) ?? deps.pageBaseUrl ?? undefined;
    try {
      const result = await deps.notify.notify({
        priority: 'notice',
        title: `Briefing · ${briefing.headline}`,
        body: briefingBodyLine(briefing),
        url,
      });
      notified = result.status !== 'error';
    } catch (err) {
      deps.log.error({ err }, 'Briefing notification dispatch failed');
    }
  }

  return { briefing, dayNodeId, rendered, notified };
}

/** Best-effort deep link to a Tana node. */
export function dayNodeLink(dayNodeId: string | null): string | undefined {
  if (!dayNodeId) return undefined;
  return `https://app.tana.inc/?nodeid=${encodeURIComponent(dayNodeId)}`;
}

function briefingBodyLine(b: Briefing): string {
  const bits: string[] = [];
  const timed = b.calendar.events.filter((e) => !e.allDay).length;
  bits.push(`${timed} meeting${timed === 1 ? '' : 's'}`);
  bits.push(`${b.calendar.alerting.length} join alert${b.calendar.alerting.length === 1 ? '' : 's'}`);
  bits.push(`${b.commitments.overdue.length} overdue`);
  bits.push(`${b.email.urgentCount} urgent email`);
  return bits.join(', ') + '.';
}
