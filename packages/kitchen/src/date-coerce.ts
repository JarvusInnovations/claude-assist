/**
 * Bare-date → local-noon coercion (specs/modules/kitchen.md § Logged-at
 * backdating — "Bare-date coercion → local noon").
 *
 * A `logged_at` / `occurred_at` / CLI `--at` supplied as a bare calendar date
 * (`YYYY-MM-DD`, no time-of-day) would parse as **midnight UTC** via
 * `new Date("YYYY-MM-DD")`. Midnight UTC is the previous evening across US
 * zones, so a bare date logged for "today" buckets onto the wrong day. Noon in
 * the machine's local timezone sits safely inside the intended day for any
 * real-world offset, so a genuinely time-less date coerces to local noon.
 *
 * This is a **backstop for a caller that omitted the time**, not a substitute:
 * a full ISO timestamp (with or without offset, any time-of-day) passes through
 * unchanged — only the bare-date case is touched. Callers/agents SHOULD supply
 * a specific local time when they have one.
 *
 * Applied at every choke point where a bare date can turn into a stored instant:
 * the CLI (`validateDate`, all `--at` sites) and the API (entry ingest, the
 * `logged_at` PATCH, and the expenditure `occurred_at` route), so the guarantee
 * holds regardless of caller.
 */

/** A bare calendar date with no time-of-day. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * If `value` is a bare `YYYY-MM-DD`, return `<date>T12:00:00<local-offset>` —
 * noon on that day in the machine's local timezone, serialized with the local
 * UTC offset **for that date** (so DST is honored for the dated day, not
 * today). Any value carrying a time-of-day is returned unchanged.
 */
export function coerceBareDateToLocalNoon(value: string): string {
  const match = DATE_ONLY.exec(value);
  if (!match) return value;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  // Local-time construction: noon on the dated day in the machine's zone. The
  // Date's own getTimezoneOffset() then reflects the offset in effect ON THAT
  // DATE — spring-forward/fall-back included — not today's offset.
  const localNoon = new Date(year, month - 1, day, 12, 0, 0, 0);
  const offsetMinutes = -localNoon.getTimezoneOffset(); // minutes east of UTC
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(offsetMinutes);
  const offH = String(Math.floor(absMinutes / 60)).padStart(2, '0');
  const offM = String(absMinutes % 60).padStart(2, '0');
  return `${value}T12:00:00${sign}${offH}:${offM}`;
}
