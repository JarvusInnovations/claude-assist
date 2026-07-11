/**
 * Email summary for the briefing, read from the google module's tables in
 * claude-assist Postgres (its home). It is split into two clearly-separated
 * tiers so the briefing never cries wolf:
 *
 *   1. "Needs attention" — the two earned tiers from the urgency pipeline, read
 *      from google.email_attention (INTERRUPT + ATTENTION, plus INTERRUPTs that
 *      were HELD for quiet hours — shown prominently). Each is listed with
 *      sender, the stored overview, and (for opportunity hits) the one-line
 *      reasoning. This widens the old alerted_at-only source.
 *   2. Everything else recent + human (personal/alert message types) is rolled
 *      up into a calm aggregate: a count plus the busiest senders, with no
 *      per-message noise unless the bucket is small.
 *
 * Untriaged backlog is surfaced separately so a stalled triage is visible.
 *
 * All reads are defensive: if the google schema/tables aren't present (module
 * disabled), the section degrades to omission with a flagged error.
 */

import type postgres from 'postgres';

export interface EmailBrief {
  subject: string;
  fromName: string;
  fromAddress: string | null;
  overview: string;
  /** Urgency tier that earned the entry: 'interrupt' | 'attention'. */
  tier?: string;
  /** True when an INTERRUPT was held overnight for quiet hours (show prominently). */
  quietHeld?: boolean;
  /** One-line reasoning for an opportunity (RFP) match, when present. */
  reason?: string | null;
}

export interface SenderTally {
  name: string;
  count: number;
}

export interface EmailSummary {
  /** Recent mail that earned an interrupt — the "needs attention" tier. */
  needsAttention: EmailBrief[];
  /** A few of the other recent human messages, for the "list when few" path. */
  otherHuman: EmailBrief[];
  /** Total count of other recent human (personal/alert) mail not in tier 1. */
  otherHumanCount: number;
  /** Busiest senders in the calmer bucket, for a one-line aggregate. */
  otherTopSenders: SenderTally[];
  /** Untriaged backlog (a stalled triage is worth seeing). */
  untriagedCount: number;
  error: string | null;
}

export interface FetchEmailOptions {
  /** Trailing window for "recent" mail. Default 24h. */
  windowHours?: number;
  /** Cap on individually-listed "needs attention" emails. Default 10. */
  limit?: number;
}

interface BriefRow {
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  overview: string | null;
}

interface AttentionBriefRow extends BriefRow {
  tier: string | null;
  quiet_held: boolean | null;
  reason: string | null;
}

function toBrief(r: BriefRow): EmailBrief {
  return {
    subject: r.subject ?? '(no subject)',
    fromName: r.from_name ?? '(unknown)',
    fromAddress: r.from_address ?? null,
    overview: r.overview ?? '',
  };
}

function toAttentionBrief(r: AttentionBriefRow): EmailBrief {
  return {
    ...toBrief(r),
    tier: r.tier ?? undefined,
    quietHeld: r.quiet_held ?? false,
    reason: r.reason ?? null,
  };
}

export async function fetchEmailSummary(
  sql: postgres.Sql,
  opts: FetchEmailOptions = {}
): Promise<EmailSummary> {
  const windowHours = opts.windowHours ?? 24;
  const limit = opts.limit ?? 10;

  try {
    // Tier 1: the two earned tiers from the urgency pipeline. Quiet-held
    // interrupts sort first (shown prominently), then by recency.
    const attentionRows = await sql<AttentionBriefRow[]>`
      SELECT a.subject,
             a.from_name,
             a.from_address,
             COALESCE(a.overview, e.analysis->>'overview') AS overview,
             a.tier AS tier,
             a.quiet_held AS quiet_held,
             a.reason AS reason
      FROM google.email_attention a
      LEFT JOIN google.emails e ON e.id = a.email_id
      WHERE a.message_date >= NOW() - (${windowHours} * INTERVAL '1 hour')
      ORDER BY a.quiet_held DESC,
               (a.tier = 'interrupt') DESC,
               a.message_date DESC
      LIMIT ${limit}
    `;

    // Tier 2: other recent human (personal/alert) mail that did NOT interrupt.
    const otherRows = await sql<BriefRow[]>`
      SELECT subject, from_name, from_address, analysis->>'overview' AS overview
      FROM google.emails
      WHERE workflow_status = 'triaged'
        AND date >= NOW() - (${windowHours} * INTERVAL '1 hour')
        AND id NOT IN (SELECT email_id FROM google.email_attention)
        AND analysis->>'sender_type' = 'human'
        AND analysis->>'message_type' IN ('personal', 'alert')
      ORDER BY date DESC
      LIMIT 3
    `;

    const [{ count: otherHumanCount } = { count: 0 }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM google.emails
      WHERE workflow_status = 'triaged'
        AND date >= NOW() - (${windowHours} * INTERVAL '1 hour')
        AND id NOT IN (SELECT email_id FROM google.email_attention)
        AND analysis->>'sender_type' = 'human'
        AND analysis->>'message_type' IN ('personal', 'alert')
    `;

    const senderRows = await sql<{ name: string | null; count: number }[]>`
      SELECT from_name AS name, COUNT(*)::int AS count
      FROM google.emails
      WHERE workflow_status = 'triaged'
        AND date >= NOW() - (${windowHours} * INTERVAL '1 hour')
        AND id NOT IN (SELECT email_id FROM google.email_attention)
        AND analysis->>'sender_type' = 'human'
        AND analysis->>'message_type' IN ('personal', 'alert')
      GROUP BY from_name
      ORDER BY count DESC, from_name ASC
      LIMIT 3
    `;

    const [{ count: untriagedCount } = { count: 0 }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM google.emails
      WHERE workflow_status IN ('new', 'discovered')
    `;

    return {
      needsAttention: attentionRows.map(toAttentionBrief),
      otherHuman: otherRows.map(toBrief),
      otherHumanCount,
      otherTopSenders: senderRows.map((s) => ({ name: s.name ?? '(unknown)', count: s.count })),
      untriagedCount,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      needsAttention: [],
      otherHuman: [],
      otherHumanCount: 0,
      otherTopSenders: [],
      untriagedCount: 0,
      error: `email summary unavailable: ${message}`,
    };
  }
}
