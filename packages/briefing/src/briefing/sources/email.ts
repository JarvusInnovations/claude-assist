/**
 * Urgent-email summary + counts for the briefing, read from the google module's
 * tables in claude-assist Postgres (its home). "Urgent" is proxied by the triage
 * analysis: human sender + a personal/alert message type, seen in the trailing
 * window. Untriaged backlog is surfaced separately so a stalled triage is visible.
 *
 * All reads are defensive: if the google schema/tables aren't present (module
 * disabled), the section degrades to omission with a flagged error.
 */

import type postgres from 'postgres';

export interface UrgentEmail {
  subject: string;
  fromName: string;
  overview: string;
}

export interface EmailSummary {
  urgent: UrgentEmail[];
  urgentCount: number;
  untriagedCount: number;
  error: string | null;
}

export interface FetchEmailOptions {
  /** Trailing window for "recent" urgent mail. Default 24h. */
  windowHours?: number;
  /** Cap on urgent examples embedded in the briefing. Default 5. */
  limit?: number;
}

export async function fetchEmailSummary(
  sql: postgres.Sql,
  opts: FetchEmailOptions = {}
): Promise<EmailSummary> {
  const windowHours = opts.windowHours ?? 24;
  const limit = opts.limit ?? 5;

  try {
    const urgentRows = await sql<{ subject: string | null; from_name: string | null; overview: string | null }[]>`
      SELECT subject,
             from_name,
             analysis->>'overview' AS overview
      FROM google.emails
      WHERE workflow_status = 'triaged'
        AND date >= NOW() - (${windowHours} * INTERVAL '1 hour')
        AND analysis->>'sender_type' = 'human'
        AND analysis->>'message_type' IN ('personal', 'alert')
      ORDER BY date DESC
      LIMIT ${limit}
    `;

    const [{ count: urgentCount } = { count: 0 }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM google.emails
      WHERE workflow_status = 'triaged'
        AND date >= NOW() - (${windowHours} * INTERVAL '1 hour')
        AND analysis->>'sender_type' = 'human'
        AND analysis->>'message_type' IN ('personal', 'alert')
    `;

    const [{ count: untriagedCount } = { count: 0 }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM google.emails
      WHERE workflow_status IN ('new', 'discovered')
    `;

    return {
      urgent: urgentRows.map((r) => ({
        subject: r.subject ?? '(no subject)',
        fromName: r.from_name ?? '(unknown)',
        overview: r.overview ?? '',
      })),
      urgentCount,
      untriagedCount,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { urgent: [], urgentCount: 0, untriagedCount: 0, error: `email summary unavailable: ${message}` };
  }
}
