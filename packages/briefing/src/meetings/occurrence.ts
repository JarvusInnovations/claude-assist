/**
 * Occurrence keying — the reliable identity that the whole cycle hinges on.
 *
 * gws-axi emits recurring-instance ids as `<base>_YYYYMMDD` or
 * `<base>_YYYYMMDDTHHMMSSZ` (the recurrence-id suffix is the OCCURRENCE's
 * *original* start in UTC). Google keeps that suffix fixed when an occurrence
 * is rescheduled — only the event's `start`/`end` move. So:
 *
 *   - seriesKey     = base id (suffix stripped)              → the override key
 *   - occurrenceKey = the full instance id                   → reschedule-stable
 *   - occurrenceStart = the event's actual (moved) start     → tracked separately
 *   - originalStart = the suffix, decoded                    → for reference
 *
 * Keying on the instance id (not on start time) is what makes a rescheduled
 * meeting keep its prep instead of spawning a duplicate.
 */

import type { CalendarEvent } from '../types.js';
import { stripInstanceSuffix, isDateOnly } from '../calendar/gws-axi.js';
import type { OccurrenceIdentity } from './types.js';

const SUFFIX_RE = /_(\d{8})(T\d{6}Z)?$/;

/**
 * Decode the recurrence-id suffix of an instance id into an ISO-ish original
 * start. `_20260710` → `2026-07-10`; `_20260710T190000Z` → `2026-07-10T19:00:00Z`.
 * Returns null for ids with no recurrence suffix (one-off events).
 */
export function decodeOriginalStart(id: string): string | null {
  const m = id.match(SUFFIX_RE);
  if (!m) return null;
  const d = m[1]!; // YYYYMMDD
  const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  if (!m[2]) return date;
  const t = m[2].slice(1); // THHMMSSZ → HHMMSSZ
  const time = `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
  return `${date}T${time}Z`;
}

/** Derive the stable occurrence identity for one calendar event. */
export function occurrenceIdentity(event: CalendarEvent): OccurrenceIdentity {
  return {
    seriesKey: event.seriesId || stripInstanceSuffix(event.id),
    occurrenceKey: event.id,
    occurrenceStart: event.start,
    occurrenceStartMs: event.startMs,
    originalStart: decodeOriginalStart(event.id),
    summary: event.summary,
  };
}

/** Epoch ms of an event's end, or null when unparseable / absent. */
export function occurrenceEndMs(event: CalendarEvent): number | null {
  const end = event.end?.trim();
  if (!end) return null;
  const ms = isDateOnly(end) ? Date.parse(`${end}T00:00:00`) : Date.parse(end);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The next occurrence of `seriesKey` strictly after `afterMs`, chosen from an
 * already-fetched forward window of events. Returns the earliest such event, or
 * null when the window holds none (e.g. the series has no future instance yet,
 * or the window was too short for a weekly cadence — the caller widens it).
 */
export function nextOccurrence(
  events: CalendarEvent[],
  seriesKey: string,
  afterMs: number
): CalendarEvent | null {
  let best: CalendarEvent | null = null;
  for (const e of events) {
    if (e.seriesId !== seriesKey) continue;
    if (e.startMs == null || e.startMs <= afterMs) continue;
    if (best == null || (best.startMs != null && e.startMs < best.startMs)) best = e;
  }
  return best;
}
