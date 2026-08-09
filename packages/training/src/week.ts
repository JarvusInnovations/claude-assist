/**
 * Calendar-week arithmetic on ISO date strings.
 *
 * Every function here works on `YYYY-MM-DD` strings and never on `Date`
 * instances in the machine's zone — the plan week is a *local* week in the
 * module's configured zone, and doing the arithmetic in UTC on date-only
 * strings is what keeps a plan generated at 23:00 from landing in tomorrow.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value);
}

function toUtcMs(dateIso: string): number {
  const ms = Date.parse(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`Not an ISO date: ${dateIso}`);
  return ms;
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(dateIso: string, days: number): string {
  return fromUtcMs(toUtcMs(dateIso) + days * DAY_MS);
}

/** Whole days from `a` to `b` (b − a). Negative when `b` precedes `a`. */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

/** ISO weekday: Monday = 1 … Sunday = 7. */
export function isoWeekday(dateIso: string): number {
  const day = new Date(toUtcMs(dateIso)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The Monday on or before `dateIso`. */
export function weekStartOf(dateIso: string): string {
  return addDays(dateIso, -(isoWeekday(dateIso) - 1));
}

/** The Monday of the week AFTER the one containing `dateIso`. */
export function nextWeekStart(dateIso: string): string {
  return addDays(weekStartOf(dateIso), 7);
}

/** The seven ISO dates of the week starting at `weekStart`. */
export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** Sunday of the week starting at `weekStart`. */
export function weekEndOf(weekStart: string): string {
  return addDays(weekStart, 6);
}

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function weekdayName(dateIso: string): string {
  return WEEKDAY_NAMES[isoWeekday(dateIso) - 1] ?? '';
}

/**
 * Today's ISO date in an IANA zone.
 *
 * `en-CA` because its short date format is already `YYYY-MM-DD`, which avoids
 * reassembling parts by hand.
 */
export function todayIsoInTz(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** UTC instants bounding [weekStart, weekStart+7) as seen from `timeZone`. */
export function weekWindowIso(
  weekStart: string,
  timeZone: string
): { fromIso: string; toIso: string } {
  return {
    fromIso: zonedMidnightIso(weekStart, timeZone),
    toIso: zonedMidnightIso(addDays(weekStart, 7), timeZone),
  };
}

/**
 * The UTC instant of local midnight on `dateIso` in `timeZone`.
 *
 * Computed by measuring the zone's offset at that nominal instant and
 * subtracting it — good to the minute for every fixed-offset moment, and off
 * only for a midnight that falls inside a DST transition, which no zone in
 * practical use has.
 */
export function zonedMidnightIso(dateIso: string, timeZone: string): string {
  const nominal = toUtcMs(dateIso);
  const offsetMin = tzOffsetMinutes(new Date(nominal), timeZone);
  return new Date(nominal - offsetMin * 60_000).toISOString();
}

/** Minutes `timeZone` is ahead of UTC at `at` (negative west of Greenwich). */
export function tzOffsetMinutes(at: Date, timeZone: string): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = Object.fromEntries(
      dtf.formatToParts(at).map((p) => [p.type, p.value])
    ) as Record<string, string>;
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour === '24' ? '00' : parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return 0;
  }
}
