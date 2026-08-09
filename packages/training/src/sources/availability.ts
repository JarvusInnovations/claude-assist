/**
 * Calendar availability for the plan week.
 *
 * Reuses the briefing module's `gws-axi calendar events` read path rather than
 * shelling out a second time with a second TOON parser — that boundary is
 * already exported for exactly this. The dependency runs one way: training
 * imports briefing's calendar reader; briefing reads training's plans over SQL
 * (the sibling-schema pattern its other sources use), so the packages don't
 * cycle.
 *
 * The rollup is per-day and coarse on purpose. The synthesis does not need a
 * timetable — it needs to know which days are jammed, which mornings start
 * early, and which days carry an all-day marker like travel, because those are
 * the facts that move a long run.
 */

import { fetchEvents, type CalendarEvent } from '@jarvus/claude-assist-briefing';
import type { AvailabilityDay, AvailabilitySummary } from '../types.js';
import { tzOffsetMinutes, weekDates, weekWindowIso } from '../week.js';

export interface AvailabilityOptions {
  weekStart: string;
  timeZone: string;
  /** gws-axi binary path (default: `gws-axi` on PATH). */
  bin?: string;
  account?: string;
}

/** Injection seam for tests. Mirrors briefing's `fetchEvents` signature. */
export type EventsFetcher = typeof fetchEvents;

/**
 * Fetch + roll up. Never throws: a missing CLI degrades to a summary of empty
 * days carrying the error, which the synthesis is told about explicitly.
 */
export async function fetchAvailability(
  opts: AvailabilityOptions,
  fetcher: EventsFetcher = fetchEvents
): Promise<AvailabilitySummary> {
  const { fromIso, toIso } = weekWindowIso(opts.weekStart, opts.timeZone);
  const result = await fetcher({
    fromIso,
    toIso,
    ...(opts.bin ? { bin: opts.bin } : {}),
    ...(opts.account ? { account: opts.account } : {}),
  });
  const days = summarizeAvailability(result.events, opts.weekStart, opts.timeZone);
  return { days, error: result.error };
}

/** Pure rollup over calendar events — exported for tests. */
export function summarizeAvailability(
  events: CalendarEvent[],
  weekStart: string,
  timeZone: string
): AvailabilityDay[] {
  const byDate = new Map<string, AvailabilityDay>();
  for (const date of weekDates(weekStart)) {
    byDate.set(date, {
      date,
      meetingCount: 0,
      busyMinutes: 0,
      firstMeetingHour: null,
      lastMeetingEndHour: null,
      allDayNotes: [],
    });
  }

  for (const event of events) {
    // Cancelled events still come back from the API; they occupy nothing.
    if (event.status === 'cancelled') continue;

    if (event.allDay) {
      // An all-day event spans [start, end) with an EXCLUSIVE end date, so a
      // one-day marker has end = start + 1. Attribute it to every day it covers
      // that falls inside the plan week.
      for (const date of allDayDates(event, byDate)) {
        byDate.get(date)?.allDayNotes.push(event.summary || '(untitled)');
      }
      continue;
    }

    const startLocal = localParts(event.start, timeZone);
    const endLocal = localParts(event.end, timeZone);
    if (!startLocal) continue;

    const day = byDate.get(startLocal.date);
    if (!day) continue;

    day.meetingCount += 1;
    if (endLocal) {
      const minutes = Math.max(0, Math.round((endLocal.ms - startLocal.ms) / 60_000));
      // Cap a single entry at a day: an all-day-ish timed event (some
      // calendars emit 24h+ timed blocks) must not make the day look
      // 3000 minutes busy and crowd out everything else in the rollup.
      day.busyMinutes += Math.min(minutes, 24 * 60);
    }
    if (day.firstMeetingHour === null || startLocal.hour < day.firstMeetingHour) {
      day.firstMeetingHour = startLocal.hour;
    }
    if (endLocal && endLocal.date === startLocal.date) {
      const endHour = endLocal.hour + (endLocal.minute > 0 ? 1 : 0);
      if (day.lastMeetingEndHour === null || endHour > day.lastMeetingEndHour) {
        day.lastMeetingEndHour = Math.min(endHour, 24);
      }
    }
  }

  return [...byDate.values()];
}

function allDayDates(event: CalendarEvent, within: Map<string, AvailabilityDay>): string[] {
  const start = event.start.slice(0, 10);
  const endExclusive = event.end.slice(0, 10) || start;
  const dates: string[] = [];
  for (const date of within.keys()) {
    if (date >= start && (date < endExclusive || date === start)) dates.push(date);
  }
  return dates;
}

interface LocalParts {
  date: string;
  hour: number;
  minute: number;
  ms: number;
}

/** An ISO instant expressed in `timeZone`. Null when unparseable. */
function localParts(iso: string, timeZone: string): LocalParts | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const at = new Date(ms);
  const shifted = new Date(ms + tzOffsetMinutes(at, timeZone) * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    ms,
  };
}
