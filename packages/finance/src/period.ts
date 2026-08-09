/**
 * Monthly period arithmetic.
 *
 * The batch runs a few days into the month and reviews the month that just
 * closed, so "which period" is a computation and not a wall-clock read. It
 * happens in the owner's zone: a run scheduled at 09:00 ET fires at 13:00 or
 * 14:00 UTC depending on the season, and on the 1st of a month that difference
 * changes which month "last month" is.
 *
 * Pure Intl, no dependency, and no `Date` mutation past noon-anchored strings.
 */

export interface Period {
  /** `YYYY-MM` — the identity of the review. */
  key: string;
  /** Inclusive ISO start date. */
  startDate: string;
  /** Inclusive ISO end date. */
  endDate: string;
  /** e.g. `March 2026`, for headings. */
  label: string;
}

/** `YYYY-MM-DD` for `now` in `timeZone`. */
export function todayIsoInTz(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now); // en-CA formats as YYYY-MM-DD
}

/** Days in a month, 1-indexed month. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Build the period for a `YYYY-MM` key. */
export function periodFromKey(key: string): Period {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) throw new Error(`Invalid period key: ${key} (expected YYYY-MM)`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid period key: ${key} (month out of range)`);
  const last = daysInMonth(year, month);
  return {
    key,
    startDate: `${key}-01`,
    endDate: `${key}-${String(last).padStart(2, '0')}`,
    label: new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'long',
      year: 'numeric',
    }).format(new Date(Date.UTC(year, month - 1, 15))),
  };
}

/** The `YYYY-MM` key immediately before `key`. */
export function priorPeriodKey(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) throw new Error(`Invalid period key: ${key}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/**
 * The period the batch should review when it fires at `now`: the most recently
 * *closed* month. Running on the 3rd of April reviews March; running on the 1st
 * of April also reviews March, which is why the boundary is computed in the
 * owner's zone rather than UTC.
 */
export function periodToReview(timeZone: string, now: Date = new Date()): Period {
  const today = todayIsoInTz(timeZone, now);
  return periodFromKey(priorPeriodKey(today.slice(0, 7)));
}
