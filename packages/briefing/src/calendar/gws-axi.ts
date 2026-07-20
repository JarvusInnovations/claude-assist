/**
 * Calendar read path, shared by both pipelines.
 *
 * `gws-axi calendar events` is the CLI-as-library boundary to Google Calendar
 * (token-authed, headless; the account defaults to the CLI's own configured
 * default, overridable via `--account`). We shell out and parse its TOON-ish
 * output into `CalendarEvent`s. The CLI's
 * absence (or a non-zero exit) degrades to an empty list with a flagged error
 * rather than throwing the whole briefing/alert cycle down.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CalendarEvent, ResponseStatus } from '../types.js';
import { decodeToonRows } from '../toon.js';

const execFileAsync = promisify(execFile);

/**
 * Columns we always request so the classifier has what it needs. `join_url` is
 * the provider-uniform join link resolved from structured conferenceData
 * (populated for Teams/Zoom/Webex, and for Meet meetings too); `hangoutLink`
 * stays requested as a fallback for Meet meetings where conferenceData/join_url
 * comes back empty.
 */
const FIELDS = 'status,attendees,location,description,hangoutLink,join_url';

export interface CalendarReadResult {
  events: CalendarEvent[];
  /** Non-null when the CLI was missing or failed — surfaced in the briefing. */
  error: string | null;
}

export interface FetchEventsOptions {
  fromIso: string;
  toIso: string;
  /** Override the binary (tests / non-PATH installs). Default: `gws-axi`. */
  bin?: string;
  account?: string;
  limit?: number;
  timeoutMs?: number;
}

/**
 * Fetch + parse events in [from, to). Never throws: a missing binary or a
 * non-zero exit resolves to `{ events: [], error }`.
 */
export async function fetchEvents(opts: FetchEventsOptions): Promise<CalendarReadResult> {
  const bin = opts.bin ?? 'gws-axi';
  const args = [
    'calendar',
    'events',
    '--from',
    opts.fromIso,
    '--to',
    opts.toIso,
    '--fields',
    FIELDS,
    '--single-events',
  ];
  if (opts.account) args.push('--account', opts.account);
  if (opts.limit) args.push('--limit', String(opts.limit));

  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { events: parseEventsToon(stdout), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { events: [], error: `gws-axi calendar read failed: ${message}` };
  }
}

/**
 * Parse gws-axi's TOON output for `calendar events`. The relevant frame is:
 *
 *   events[3]{id,summary,start,end,my_response,attachments,status,attendees,...,join_url}:
 *     abc_20260710,Office,2026-07-10,2026-07-11,"","",ok,"",...,""
 *
 * The canonical TOON decoder handles the header + indented rows (including
 * backslash-escaped quotes/newlines in fields). Returns [] when no `events`
 * frame is present; throws on malformed output, which `fetchEvents` catches and
 * degrades to `{ events: [], error }`. Exported for tests.
 */
export function parseEventsToon(output: string): CalendarEvent[] {
  const rows = decodeToonRows(output, 'events');
  if (!rows) return [];
  return rows.map((rec) => rowToEvent(rec));
}

const RESPONSE_VALUES: ResponseStatus[] = [
  '',
  'accepted',
  'declined',
  'tentative',
  'needsAction',
];

function rowToEvent(rec: Record<string, string>): CalendarEvent {
  const get = (name: string): string => rec[name] ?? '';

  const id = get('id');
  const start = get('start');
  const end = get('end');
  const rawResponse = get('my_response');
  const myResponse = (RESPONSE_VALUES as string[]).includes(rawResponse)
    ? (rawResponse as ResponseStatus)
    : '';

  return {
    id,
    seriesId: stripInstanceSuffix(id),
    summary: get('summary'),
    start,
    end,
    allDay: isDateOnly(start),
    startMs: parseStartMs(start),
    myResponse,
    attendeeCount: parseAttendeeCount(get('attendees')),
    location: get('location'),
    joinUrl: get('join_url'),
    hangoutLink: get('hangoutLink'),
    description: get('description'),
    status: get('status'),
  };
}

/** Recurring instances append `_YYYYMMDD` or `_YYYYMMDDTHHMMSSZ` to the base id. */
export function stripInstanceSuffix(id: string): string {
  return id.replace(/_\d{8}(T\d{6}Z)?$/, '');
}

export function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function parseStartMs(start: string): number | null {
  const s = start.trim();
  if (!s) return null;
  // Date-only (all-day): treat as local midnight so "today" math is stable.
  const ms = isDateOnly(s) ? Date.parse(`${s}T00:00:00`) : Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

/** "5 (1 accepted, 3 needsAction, 1 declined)" → 5; "" → 0. */
export function parseAttendeeCount(field: string): number {
  const m = field.trim().match(/^(\d+)/);
  return m ? Number(m[1]) : 0;
}
