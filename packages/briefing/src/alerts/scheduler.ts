/**
 * Alert scheduler cycle.
 *
 * Runs every minute: resolve the alert plan for the near-term window, then fire
 * exactly one `interrupt`-priority dispatch per qualifying occurrence once its
 * lead time arrives. "Due" = the fire-at instant has passed and we're at most a
 * short grace past the meeting start (a second grace after fire-at covers a
 * restart landing just after fire-at). The dedup ledger's atomic claim is what
 * makes it exactly-once.
 *
 * `runAlertCycle` takes already-fetched events so it stays pure + testable; the
 * plugin owns the gws-axi read and the heartbeat beat.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { NotifyDispatcher } from '@jarvus/claude-assist-core';
import type { AlertPlanItem, CalendarEvent, SeriesOverride } from '../types.js';
import type { JoinRequiredModel } from '../classifier/llm.js';
import type { MeetingPrep } from '../meetings/types.js';
import type { MeetingPrepStore } from '../meetings/prep-store.js';
import { conferencingUrl } from '../classifier/join-required.js';
import { alertingItems, resolveAlertPlan } from './plan.js';
import type { DispatchLedger } from './dispatch-ledger.js';

/**
 * Grace after fire-at during which a late cycle still fires (covers a restart or
 * a slow tick). Kept short so a stale alert never lands well after the meeting.
 */
export const FIRE_GRACE_MS = 5 * 60_000;

/**
 * Grace after the meeting *start* during which an alert may still fire. With a
 * short lead (1 min) the due window is barely wider than the scan cadence, so a
 * cycle can legitimately land seconds past start — and a "just started" alert
 * beats silence. Kept under two minutes so a genuinely stale alert never fires
 * well into a meeting.
 */
export const STARTED_GRACE_MS = 90_000;

export interface AlertCycleDeps {
  events: CalendarEvent[];
  overrides: Map<string, SeriesOverride>;
  model?: JoinRequiredModel | null;
  ledger: DispatchLedger;
  notify: NotifyDispatcher | undefined;
  log: FastifyBaseLogger;
  nowMs: number;
  /**
   * Optional prep lookup: when the occurrence has a delivered meeting prep,
   * the alert carries a link to its Tana node. The alert's event id IS the
   * prep store's occurrence_key (both are the calendar instance id — see
   * meetings/occurrence.ts), so the lookup is a direct get. Absent store, no
   * prep, or a lookup failure → alert unchanged.
   */
  prepStore?: MeetingPrepStore | null;
}

export interface AlertCycleResult {
  evaluated: number;
  alerting: number;
  due: number;
  fired: number;
}

/**
 * True when `now` is within [fireAt, min(start+startedGrace, fireAt+grace)] —
 * i.e. due to fire. Firing shortly *after* start is deliberate: the scan
 * cadence can land a cycle seconds past start, and a late-by-seconds "meeting
 * just started" alert is still actionable where silence is not. Both caps stay
 * short so a stale alert never lands well into (or well after) the meeting.
 */
export function isDue(
  item: AlertPlanItem,
  nowMs: number,
  graceMs = FIRE_GRACE_MS,
  startedGraceMs = STARTED_GRACE_MS
): boolean {
  if (item.fireAtMs == null) return false;
  if (nowMs < item.fireAtMs) return false;
  // Don't fire once the meeting is more than briefly underway.
  if (item.event.startMs != null && nowMs > item.event.startMs + startedGraceMs) return false;
  // And don't fire absurdly late relative to fire-at (missed the window entirely).
  return nowMs <= item.fireAtMs + graceMs;
}

export async function runAlertCycle(deps: AlertCycleDeps): Promise<AlertCycleResult> {
  const { events, overrides, model, ledger, notify, log, nowMs, prepStore } = deps;

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

    // Fail-soft prep lookup — a broken prep store must never block the alert.
    let prep: MeetingPrep | null = null;
    if (prepStore) {
      try {
        prep = await prepStore.get(item.event.id);
      } catch (err) {
        log.warn({ err, eventId: item.event.id }, 'Prep lookup failed; alert fires without prep link');
      }
    }

    try {
      const result = await notify.notify({
        priority: 'interrupt',
        ...buildAlertPayload(item, prep),
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
  // Never embed the join link as body text — it lives in the tappable URL slot
  // (alertUrl). A physical/name-only location is plain context, not a link, so
  // it stays; a raw hangoutLink in the body would just duplicate the button as
  // untappable text.
  if (!item.event.hangoutLink && item.event.location) parts.push(item.event.location);
  return parts.join(' ');
}

/**
 * The tappable action link for a meeting alert. A conferencing URL wins and
 * gets a "Join" label. A physical-venue meeting with no conferencing link (and
 * no bare-domain fallback) gets a maps search link instead — trivially
 * derivable from the location string, no geocoding needed. Otherwise no link.
 */
export function alertUrl(item: AlertPlanItem): { url?: string; urlTitle?: string } {
  const join = conferencingUrl(item.event);
  if (join) return { url: join, urlTitle: 'Join' };

  if (item.classification.venue === 'physical' && item.event.location.trim()) {
    return {
      url: `https://maps.google.com/?q=${encodeURIComponent(item.event.location.trim())}`,
      urlTitle: 'Map',
    };
  }

  return {};
}

/** Deep link to a Tana node (same format the daily briefing's day-node link uses). */
export function prepNodeLink(nodeId: string): string {
  return `https://app.tana.inc/?nodeid=${encodeURIComponent(nodeId)}`;
}

/**
 * Assemble the dispatch payload for one due alert, folding in the occurrence's
 * meeting prep when one has been delivered to Tana.
 *
 * The URL slot is the alert's single tappable action, and tap-to-join is its
 * primary job — so an action link from `alertUrl` (Join/Map) always keeps the
 * slot. When a join/map link claims it, the prep is referenced by its home
 * ("Prep in today's note") rather than embedded as a raw URL in the body — no
 * alert ever puts a dead, untappable link in its body text. Only when the
 * alert has no action link does the prep link take the URL slot (labeled
 * "Prep"). No prep, or a prep never rendered to Tana (no node id) → payload
 * carries no prep reference.
 */
export function buildAlertPayload(
  item: AlertPlanItem,
  prep?: MeetingPrep | null
): { title: string; body: string; url?: string; urlTitle?: string } {
  const title = alertTitle(item);
  const action = alertUrl(item);
  const prepUrl = prep?.deliveredNodeId ? prepNodeLink(prep.deliveredNodeId) : null;

  if (!prepUrl) return { title, body: alertBody(item), ...action };
  // Pushover offers a single URL button. When a join/map link claims it, the
  // prep link would otherwise land as raw text in the body — untappable from
  // the notification. Point at the prep's durable home (today's day note)
  // instead of embedding a dead link; the join button stays the one action.
  if (action.url) return { title, body: `${alertBody(item)} Prep in today's note.`, ...action };
  return { title, body: alertBody(item), url: prepUrl, urlTitle: 'Prep' };
}
