/**
 * Timezone helpers. The claude-assist server runs in UTC (the notify staleness
 * cron `0 13 * * *` is commented "~09:00 ET"), so "today" and day boundaries
 * must be computed explicitly in Chris's zone rather than read off the machine
 * clock. Pure Intl — no dependency.
 */

/** Wall-clock minus actual-UTC, in minutes, for `date` in `timeZone`. */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
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
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour === '24' ? '0' : map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return (asUTC - date.getTime()) / 60_000;
}

/** `YYYY-MM-DD` for `now` in `timeZone`. */
export function todayIsoInTz(timeZone: string, now: Date = new Date()): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dtf.format(now); // en-CA formats as YYYY-MM-DD
}

/** Epoch ms of local midnight starting `dateIso` in `timeZone`. */
export function zonedDayStartMs(dateIso: string, timeZone: string): number {
  const utcMidnight = Date.parse(`${dateIso}T00:00:00Z`);
  const offset = tzOffsetMinutes(new Date(utcMidnight), timeZone);
  return utcMidnight - offset * 60_000;
}

/** [startIso, endIso) covering the whole day `dateIso` in `timeZone`, as ISO-Z. */
export function zonedDayWindow(dateIso: string, timeZone: string): { fromIso: string; toIso: string } {
  const startMs = zonedDayStartMs(dateIso, timeZone);
  const endMs = startMs + 24 * 3_600_000;
  return {
    fromIso: new Date(startMs).toISOString(),
    toIso: new Date(endMs).toISOString(),
  };
}

/**
 * `YYYY-MM-DD` for the calendar day immediately before `dateIso`. Plain date
 * arithmetic on the date string itself (noon-anchored to dodge DST edge cases
 * in `setUTCDate`) — `dateIso` is already framed as a "local day" by its
 * caller, so no timezone parameter is needed here.
 */
export function priorDateIso(dateIso: string): string {
  const d = new Date(`${dateIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
