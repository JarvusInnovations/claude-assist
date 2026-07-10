/**
 * Alert scheduler cycle.
 *
 * Runs every couple of minutes: resolve the alert plan for the near-term window,
 * then fire exactly one `interrupt`-priority dispatch per qualifying occurrence
 * once its lead time arrives. "Due" = the fire-at instant has passed and the
 * meeting hasn't started yet (a small grace covers a restart landing just after
 * fire-at). The dedup ledger's atomic claim is what makes it exactly-once.
 *
 * `runAlertCycle` takes already-fetched events so it stays pure + testable; the
 * plugin owns the gws-axi read and the heartbeat beat.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { NotifyDispatcher } from '@jarvus/claude-assist-core';
import type { AlertPlanItem, CalendarEvent, SeriesOverride } from '../types.js';
import type { JoinRequiredModel } from '../classifier/llm.js';
import { alertingItems, resolveAlertPlan } from './plan.js';
import type { DispatchLedger } from './dispatch-ledger.js';

/**
 * Grace after fire-at during which a late cycle still fires (covers a restart or
 * a slow tick). Kept short so a stale alert never lands well after the meeting.
 */
export const FIRE_GRACE_MS = 5 * 60_000;

export interface AlertCycleDeps {
  events: CalendarEvent[];
  overrides: Map<string, SeriesOverride>;
  model?: JoinRequiredModel | null;
  ledger: DispatchLedger;
  notify: NotifyDispatcher | undefined;
  log: FastifyBaseLogger;
  nowMs: number;
}

export interface AlertCycleResult {
  evaluated: number;
  alerting: number;
  due: number;
  fired: number;
}

/** True when `now` is within [fireAt, min(start, fireAt+grace)] — i.e. due to fire. */
export function isDue(item: AlertPlanItem, nowMs: number, graceMs = FIRE_GRACE_MS): boolean {
  if (item.fireAtMs == null) return false;
  if (nowMs < item.fireAtMs) return false;
  // Don't fire once the meeting has started.
  if (item.event.startMs != null && nowMs > item.event.startMs) return false;
  // And don't fire absurdly late (missed the window entirely).
  return nowMs <= item.fireAtMs + graceMs;
}

export async function runAlertCycle(deps: AlertCycleDeps): Promise<AlertCycleResult> {
  const { events, overrides, model, ledger, notify, log, nowMs } = deps;

  const plan = await resolveAlertPlan({ events, overrides, model });
  const alerting = alertingItems(plan);
  const due = alerting.filter((item) => isDue(item, nowMs));

  let fired = 0;
  for (const item of due) {
    const claimed = await ledger.claim(item);
    if (!claimed) continue; // already dispatched (dedup) — restart-safe

    if (!notify) {
      log.warn(
        { eventId: item.event.id, summary: item.event.summary },
        'Meeting alert due but notify dispatcher unavailable'
      );
      continue;
    }

    try {
      const result = await notify.notify({
        priority: 'interrupt',
        title: alertTitle(item),
        body: alertBody(item),
      });
      await ledger.recordNotify(item.event.id, result.id);
      fired++;
      log.info(
        { eventId: item.event.id, summary: item.event.summary, leadMinutes: item.leadMinutes },
        'Meeting alert fired'
      );
    } catch (err) {
      log.error({ err, eventId: item.event.id }, 'Meeting alert dispatch failed');
    }
  }

  return { evaluated: events.length, alerting: alerting.length, due: due.length, fired };
}

export function alertTitle(item: AlertPlanItem): string {
  const mins = item.leadMinutes ?? 0;
  return `${item.event.summary || 'Meeting'} in ${mins} min`;
}

export function alertBody(item: AlertPlanItem): string {
  const parts: string[] = [];
  const when = item.event.start.includes('T')
    ? item.event.start.slice(11, 16)
    : item.event.start;
  parts.push(`Starts ${when}.`);
  if (item.event.hangoutLink) parts.push(item.event.hangoutLink);
  else if (item.event.location) parts.push(item.event.location);
  return parts.join(' ');
}
