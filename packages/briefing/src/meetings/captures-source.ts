/**
 * Meeting-routed captures — the "rolling agenda capture" input.
 *
 * Reads the capture module's table (same claude-assist Postgres) for captures
 * associated with a recurring meeting's SERIES key, via either routing path the
 * capture migration documents:
 *   - `meeting_series_key = <seriesKey>` (explicit routing column), or
 *   - a `meeting:<seriesKey>` entry in the `tags[]` array (the tag convention).
 *
 * Scoped to captures received since the prior occurrence (so a prep folds only
 * the agenda that accrued between meetings). Degrades to empty (flagged) if the
 * capture schema/column is absent — the prep still composes from the rest.
 */

import type postgres from 'postgres';

export interface MeetingCapture {
  ulid: string;
  text: string;
  capturedAt: string;
  tags: string[];
}

export interface MeetingCapturesResult {
  captures: MeetingCapture[];
  error: string | null;
}

export interface FetchMeetingCapturesOptions {
  seriesKey: string;
  /** Only captures received at/after this epoch-ms (default: no lower bound). */
  sinceMs?: number | null;
  limit?: number;
}

/** The tag convention that associates a capture with a meeting series. */
export function meetingTag(seriesKey: string): string {
  return `meeting:${seriesKey}`;
}

interface CaptureRow {
  ulid: string;
  text: string;
  captured_at: Date | string;
  tags: string[] | null;
}

export async function fetchMeetingCaptures(
  sql: postgres.Sql,
  opts: FetchMeetingCapturesOptions
): Promise<MeetingCapturesResult> {
  const since = opts.sinceMs != null ? new Date(opts.sinceMs) : new Date(0);
  const limit = Math.min(opts.limit ?? 50, 200);
  const tag = meetingTag(opts.seriesKey);
  try {
    const rows = await sql<CaptureRow[]>`
      SELECT ulid, text, captured_at, tags
      FROM capture.captures
      WHERE (meeting_series_key = ${opts.seriesKey} OR tags @> ${[tag] as unknown as string[]})
        AND captured_at >= ${since}
      ORDER BY captured_at ASC
      LIMIT ${limit}
    `;
    return {
      captures: rows.map((r) => ({
        ulid: r.ulid,
        text: r.text,
        capturedAt: r.captured_at instanceof Date ? r.captured_at.toISOString() : r.captured_at,
        tags: r.tags ?? [],
      })),
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { captures: [], error: `meeting captures unavailable: ${message}` };
  }
}
