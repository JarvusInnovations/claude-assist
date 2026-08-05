/**
 * Owner-timezone resolver + local-day helpers (specs/modules/kitchen.md
 * § Timezone & local-day bucketing).
 *
 * The module OWNS timezone and day-bucketing so no AXI caller ever supplies,
 * knows, or computes an offset to get correct day-grouped data. A single
 * configured IANA zone (`KITCHEN_OWNER_TZ`) is the one source of truth for every
 * day boundary; unset ⇒ UTC fallback, stated in the affected output (never a
 * silent guess).
 *
 * All conversions go through `Intl.DateTimeFormat` per-instant — no hardcoded
 * offsets — so every result is DST-correct for the specific date.
 */

/** Resolved owner-timezone context, computed once at startup. */
export interface OwnerTz {
  /** The IANA zone used for every day computation (`UTC` on fallback). */
  zone: string;
  /**
   * True when `KITCHEN_OWNER_TZ` was unset/blank and the module fell back to
   * UTC. Callers surface `note` in affected output when this is set.
   */
  fallback: boolean;
  /**
   * The zone label to state in output: the IANA zone normally, or
   * `"UTC (KITCHEN_OWNER_TZ unset)"` on fallback — a stated fallback, never a
   * silent guess.
   */
  note: string;
}

/** Thrown at boot when `KITCHEN_OWNER_TZ` names a zone the runtime can't resolve. */
export class OwnerTzConfigError extends Error {
  constructor(message: string) {
    super(`KITCHEN_OWNER_TZ: ${message}`);
    this.name = 'OwnerTzConfigError';
  }
}

/**
 * Resolve `KITCHEN_OWNER_TZ` once at startup. A blank/absent value falls back
 * to UTC (stated). A present-but-invalid zone fails loudly (same doctrine as
 * the other kitchen config: a misread zone is worse than an announced UTC).
 */
export function resolveOwnerTz(configured?: string | null): OwnerTz {
  const raw = typeof configured === 'string' ? configured.trim() : '';
  if (raw === '') {
    return { zone: 'UTC', fallback: true, note: 'UTC (KITCHEN_OWNER_TZ unset)' };
  }
  // Validate by attempting a format — an unknown zone throws RangeError.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
  } catch {
    throw new OwnerTzConfigError(`"${raw}" is not a valid IANA timezone`);
  }
  return { zone: raw, fallback: false, note: raw };
}

/**
 * Offset (minutes east of UTC) in effect at `instant` for `zone`. Looked up
 * per-instant via `Intl` so it is DST-correct for that exact moment.
 */
export function offsetMinutes(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  // "GMT-04:00", "GMT+05:30", or plain "GMT" (== UTC, offset 0).
  const m = /GMT([+-])(\d{2}):?(\d{2})/.exec(name);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * The owner-local calendar date (`YYYY-MM-DD`) of a UTC instant. Shifting the
 * instant by the zone's own offset for that instant, then reading the UTC-labeled
 * date, yields the local calendar day DST-correctly.
 */
export function localDay(instant: Date, zone: string): string {
  const shifted = new Date(instant.getTime() + offsetMinutes(instant, zone) * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The instant rendered in the owner zone as an ISO string carrying its explicit
 * offset (e.g. `2026-07-25T20:47:00-04:00`) — never a bare `Z`, so an agent
 * reading the row sees the local wall-clock time directly.
 */
export function localDisplay(instant: Date, zone: string): string {
  const off = offsetMinutes(instant, zone);
  const shifted = new Date(instant.getTime() + off * 60_000);
  const wall = shifted.toISOString().slice(0, 19); // YYYY-MM-DDTHH:mm:ss
  return `${wall}${formatOffset(off)}`;
}

/** Format an offset in minutes east of UTC as `Z` / `±HH:MM`. */
export function formatOffset(minutes: number): string {
  if (minutes === 0) return 'Z';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/** The owner-local "today" (`YYYY-MM-DD`) at the given instant (defaults to now). */
export function localToday(zone: string, now: Date = new Date()): string {
  return localDay(now, zone);
}

/** A bare calendar date with no time-of-day. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` calendar day as the UTC-midnight `Date` a `DATE` column round-trips. */
function dayValue(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * Resolve a caller-supplied `at` into the **owner-local calendar day**, as the
 * UTC-midnight `Date` a `DATE` column stores and round-trips.
 *
 * Three inputs, one answer — "what day was this, where the owner lives":
 *
 * - **Absent** → the owner-local day *now*. Deriving it from the UTC date is the
 *   defect this exists to prevent: any evening event in a western-hemisphere
 *   instance has already crossed into the next UTC day, so a UTC-stamped date
 *   lands a day late while the journal entry for the same act buckets correctly.
 * - **A bare `YYYY-MM-DD`** → taken **verbatim**. The caller named a calendar
 *   day and the column stores calendar days; there is no instant in between to
 *   convert, and converting one would only re-introduce a zone the caller never
 *   meant to state.
 * - **An instant** → the owner-local day *of that instant*, so a full local
 *   timestamp with an offset lands on the day its wall clock read.
 *
 * An unparseable value falls back to "now" rather than throwing: these are date
 * *stamps* on an event that already happened, and the API validates the shape of
 * anything it accepts upstream.
 */
export function ownerLocalDate(
  input: string | null | undefined,
  zone: string,
  now: Date = new Date()
): Date {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') return dayValue(localDay(now, zone));
  if (DATE_ONLY.test(raw)) return dayValue(raw);
  const instant = new Date(raw);
  if (Number.isNaN(instant.getTime())) return dayValue(localDay(now, zone));
  return dayValue(localDay(instant, zone));
}

/**
 * Resolve a caller-supplied `at` into an **instant** for a `timestamptz` column
 * (the consumption entry an inventory verb writes alongside its item update),
 * with the same day semantics as `ownerLocalDate`.
 *
 * A bare `YYYY-MM-DD` becomes **noon in the owner zone** — the § Logged-at
 * backdating backstop, resolved against the owner's zone rather than whatever
 * machine happened to send it, so the entry buckets on the day the caller named.
 * Any value carrying a time-of-day passes through as the instant it names.
 */
export function ownerLocalInstant(
  input: string | null | undefined,
  zone: string,
  now: Date = new Date()
): Date {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') return now;
  if (DATE_ONLY.test(raw)) {
    // Noon UTC on the named day is the probe: it is inside that day in every
    // real-world zone, so the offset it reads is the one in effect at local
    // noon there. Shifting back by that offset yields local noon as an instant.
    const probe = new Date(`${raw}T12:00:00.000Z`);
    return new Date(probe.getTime() - offsetMinutes(probe, zone) * 60_000);
  }
  const instant = new Date(raw);
  return Number.isNaN(instant.getTime()) ? now : instant;
}
