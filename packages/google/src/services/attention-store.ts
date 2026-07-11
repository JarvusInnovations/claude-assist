/**
 * Email attention store — the durable home for both earned tiers (INTERRUPT and
 * ATTENTION), mirroring slack_urgency.candidates + its near_misses view.
 *
 * `EmailAttentionStore` is an interface so the pipeline is testable without
 * Postgres (see MemoryEmailAttentionStore). PgEmailAttentionStore is the
 * production implementation over `google.email_attention` (migration 006).
 *
 * `email_id` is the idempotency key: a re-triage of the same email upserts one
 * row. The daily-briefing "Needs attention" section reads this store by name.
 */

import type postgres from 'postgres';

export type AttentionTier = 'interrupt' | 'attention';
export type AttentionVerdict = 'interrupt' | 'attention' | 'quiet_held';

export interface AttentionRecordInput {
  emailId: number;
  accountId: number;
  tier: AttentionTier;
  verdict: AttentionVerdict;
  classifier: 'deterministic' | 'model';
  model: string | null;
  reason: string;
  gist: string | null;
  signals: string[];
  confidence: number | null;
  fromName: string | null;
  fromAddress: string | null;
  subject: string | null;
  overview: string | null;
  opportunityMatch: boolean;
  opportunityHigh: boolean;
  interrupted: boolean;
  quietHeld: boolean;
  notificationId: number | null;
  messageDate: Date | null;
}

export interface AttentionRow {
  email_id: number;
  account_id: number | null;
  tier: string;
  verdict: string;
  classifier: string;
  model: string | null;
  reason: string | null;
  gist: string | null;
  signals: string[];
  confidence: number | null;
  from_name: string | null;
  from_address: string | null;
  subject: string | null;
  overview: string | null;
  opportunity_match: boolean;
  opportunity_high: boolean;
  interrupted: boolean;
  quiet_held: boolean;
  notification_id: number | null;
  message_date: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface EmailAttentionStore {
  /** Idempotent upsert of an attention-worthy email (email_id is the key). */
  record(input: AttentionRecordInput): Promise<void>;
  /** Attention-worthy items within a trailing window (most recent first). */
  listRecent(windowHours: number, limit: number): Promise<AttentionRow[]>;
  /** A single stored record by email id. */
  get(emailId: number): Promise<AttentionRow | null>;
}

export class PgEmailAttentionStore implements EmailAttentionStore {
  constructor(private sql: postgres.Sql) {}

  async record(input: AttentionRecordInput): Promise<void> {
    await this.sql`
      INSERT INTO google.email_attention
        (email_id, account_id, tier, verdict, classifier, model, reason, gist,
         signals, confidence, from_name, from_address, subject, overview,
         opportunity_match, opportunity_high, interrupted, quiet_held,
         notification_id, message_date)
      VALUES (
        ${input.emailId}, ${input.accountId}, ${input.tier}, ${input.verdict},
        ${input.classifier}, ${input.model}, ${input.reason}, ${input.gist},
        ${input.signals as unknown as string[]}, ${input.confidence},
        ${input.fromName}, ${input.fromAddress}, ${input.subject}, ${input.overview},
        ${input.opportunityMatch}, ${input.opportunityHigh}, ${input.interrupted},
        ${input.quietHeld}, ${input.notificationId}, ${input.messageDate}
      )
      ON CONFLICT (email_id) DO UPDATE SET
        tier = EXCLUDED.tier,
        verdict = EXCLUDED.verdict,
        classifier = EXCLUDED.classifier,
        model = EXCLUDED.model,
        reason = EXCLUDED.reason,
        gist = EXCLUDED.gist,
        signals = EXCLUDED.signals,
        confidence = EXCLUDED.confidence,
        from_name = EXCLUDED.from_name,
        from_address = EXCLUDED.from_address,
        subject = EXCLUDED.subject,
        overview = EXCLUDED.overview,
        opportunity_match = EXCLUDED.opportunity_match,
        opportunity_high = EXCLUDED.opportunity_high,
        interrupted = EXCLUDED.interrupted,
        quiet_held = EXCLUDED.quiet_held,
        notification_id = EXCLUDED.notification_id,
        message_date = EXCLUDED.message_date
    `;
  }

  async listRecent(windowHours: number, limit: number): Promise<AttentionRow[]> {
    return this.sql<AttentionRow[]>`
      SELECT * FROM google.email_attention
      WHERE message_date >= NOW() - (${windowHours} * INTERVAL '1 hour')
      ORDER BY quiet_held DESC, message_date DESC
      LIMIT ${limit}
    `;
  }

  async get(emailId: number): Promise<AttentionRow | null> {
    const [row] = await this.sql<AttentionRow[]>`
      SELECT * FROM google.email_attention WHERE email_id = ${emailId}
    `;
    return row ?? null;
  }
}

/** In-memory store for tests. Mirrors PgEmailAttentionStore semantics. */
export class MemoryEmailAttentionStore implements EmailAttentionStore {
  rows = new Map<number, AttentionRow>();

  async record(input: AttentionRecordInput): Promise<void> {
    const existing = this.rows.get(input.emailId);
    const now = new Date();
    this.rows.set(input.emailId, {
      email_id: input.emailId,
      account_id: input.accountId,
      tier: input.tier,
      verdict: input.verdict,
      classifier: input.classifier,
      model: input.model,
      reason: input.reason,
      gist: input.gist,
      signals: input.signals,
      confidence: input.confidence,
      from_name: input.fromName,
      from_address: input.fromAddress,
      subject: input.subject,
      overview: input.overview,
      opportunity_match: input.opportunityMatch,
      opportunity_high: input.opportunityHigh,
      interrupted: input.interrupted,
      quiet_held: input.quietHeld,
      notification_id: input.notificationId,
      message_date: input.messageDate,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
  }

  async listRecent(windowHours: number, limit: number): Promise<AttentionRow[]> {
    const cutoff = Date.now() - windowHours * 3600_000;
    return [...this.rows.values()]
      .filter((r) => (r.message_date?.getTime() ?? 0) >= cutoff)
      .sort((a, b) => {
        if (a.quiet_held !== b.quiet_held) return a.quiet_held ? -1 : 1;
        return (b.message_date?.getTime() ?? 0) - (a.message_date?.getTime() ?? 0);
      })
      .slice(0, limit);
  }

  async get(emailId: number): Promise<AttentionRow | null> {
    return this.rows.get(emailId) ?? null;
  }
}
