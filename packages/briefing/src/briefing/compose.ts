/**
 * Briefing composition — assembles the morning briefing's content contract from
 * its source results into a structured `Briefing`, and derives the 2–3 headline
 * items for the delivery ping. Pure and fully testable with fakes; the render
 * (render.ts) turns a `Briefing` into Tana Paste and writes the day node.
 *
 * Content contract (per plans/daily-briefing.md):
 *   today's calendar (with which events will alert), open commitments,
 *   email split into a "needs attention" tier + a calm aggregate, captures
 *   awaiting review, coverage staleness,
 *   pipeline health, and links out to richer claude-assist pages. Sources that
 *   aren't live render as "not-yet-available", never failing the whole briefing.
 */

import type { AlertPlanItem, CalendarEvent } from '../types.js';
import { alertingItems } from '../alerts/plan.js';
import type { CalendarReadResult } from '../calendar/gws-axi.js';
import type { CommitmentsResult, OpenCommitment } from './sources/commitments.js';
import type { EmailSummary } from './sources/email.js';
import type { CapturesSummary } from './sources/captures.js';
import type { CoverageSummary } from './sources/coverage.js';

export interface BriefingLink {
  label: string;
  url: string;
}

export interface BriefingInputs {
  dateIso: string;
  calendar: CalendarReadResult;
  alertPlan: AlertPlanItem[];
  commitments: CommitmentsResult;
  email: EmailSummary;
  captures: CapturesSummary;
  coverage: CoverageSummary;
  /** Base URL for links out to richer claude-assist pages (optional). */
  pageBaseUrl?: string | null;
}

export interface Briefing {
  dateIso: string;
  headline: string;
  calendar: {
    events: CalendarEvent[];
    /** Events that will alert today, in fire order. */
    alerting: AlertPlanItem[];
    error: string | null;
  };
  commitments: {
    overdue: OpenCommitment[];
    dueToday: OpenCommitment[];
    upcomingCount: number;
    error: string | null;
  };
  email: EmailSummary;
  captures: CapturesSummary;
  coverage: CoverageSummary;
  links: BriefingLink[];
}

export function composeBriefing(inputs: BriefingInputs): Briefing {
  const alerting = alertingItems(inputs.alertPlan);

  const overdue = inputs.commitments.commitments.filter((c) => c.overdue);
  const dueToday = inputs.commitments.commitments.filter((c) => c.dueToday);
  const upcomingCount = inputs.commitments.commitments.length - overdue.length - dueToday.length;

  const links = buildLinks(inputs.pageBaseUrl ?? null);

  return {
    dateIso: inputs.dateIso,
    headline: buildHeadline({
      timedMeetings: inputs.calendar.events.filter((e) => !e.allDay).length,
      alertingCount: alerting.length,
      overdueCount: overdue.length,
      dueTodayCount: dueToday.length,
      needsAttentionCount: inputs.email.needsAttention.length,
    }),
    calendar: {
      events: inputs.calendar.events,
      alerting,
      error: inputs.calendar.error,
    },
    commitments: {
      overdue,
      dueToday,
      upcomingCount: Math.max(0, upcomingCount),
      error: inputs.commitments.error,
    },
    email: inputs.email,
    captures: inputs.captures,
    coverage: inputs.coverage,
    links,
  };
}

interface HeadlineInputs {
  timedMeetings: number;
  alertingCount: number;
  overdueCount: number;
  dueTodayCount: number;
  needsAttentionCount: number;
}

/** 2–3 salient items for the delivery ping title. */
export function buildHeadline(h: HeadlineInputs): string {
  const parts: string[] = [];
  if (h.alertingCount > 0) parts.push(`${h.alertingCount} to join`);
  else if (h.timedMeetings > 0) parts.push(`${h.timedMeetings} mtg${h.timedMeetings === 1 ? '' : 's'}`);
  if (h.overdueCount > 0) parts.push(`${h.overdueCount} overdue`);
  else if (h.dueTodayCount > 0) parts.push(`${h.dueTodayCount} due today`);
  if (h.needsAttentionCount > 0) parts.push(`${h.needsAttentionCount} email needs attention`);

  if (parts.length === 0) return 'Clear day — no meetings, nothing overdue';
  return parts.slice(0, 3).join(' · ');
}

function buildLinks(base: string | null): BriefingLink[] {
  if (!base) return [];
  const root = base.replace(/\/+$/, '');
  return [
    { label: 'Inbox / captures', url: `${root}/inbox` },
    { label: 'Emails', url: `${root}/emails` },
    { label: 'System / pipelines', url: `${root}/system` },
  ];
}
