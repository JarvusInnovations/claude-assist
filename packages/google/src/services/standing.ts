/**
 * Digest v2 stores: per-sender standing + the classification refinement queue.
 *
 * Both back interactive-digest affordances (behavior: email-digest). They are
 * deliberately dumb data stores — they capture signal; they do NOT mutate any
 * triage rule or prompt. Policy change happens only in a reviewed interactive
 * session that drains the refinement queue ("corrections are gathered,
 * revisions are sessions").
 */

import type postgres from 'postgres';

export type SenderStanding = 'whitelist' | 'unsubscribe_queue';

export interface SenderStandingRow {
  sender_email: string;
  standing: SenderStanding;
  set_at: Date;
  source: string | null;
}

export type RefinementStatus = 'pending' | 'resolved';

export interface RefinementRow {
  id: number;
  email_id: number;
  from_class: string | null;
  to_class: string;
  note: string | null;
  status: RefinementStatus;
  resolution: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

/** Normalize a sender address for use as the standing key. */
export function normalizeSender(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Per-sender standing store (whitelist / unsubscribe-queue). */
export class SenderStandingStore {
  constructor(private sql: postgres.Sql) {}

  /** Upsert a sender's standing; a later tap overwrites the earlier one. */
  async set(
    senderEmail: string,
    standing: SenderStanding,
    source = 'digest_page'
  ): Promise<SenderStandingRow> {
    const email = normalizeSender(senderEmail);
    const [row] = await this.sql<SenderStandingRow[]>`
      INSERT INTO google.sender_standing (sender_email, standing, source, set_at)
      VALUES (${email}, ${standing}, ${source}, NOW())
      ON CONFLICT (sender_email)
      DO UPDATE SET standing = EXCLUDED.standing,
                    source = EXCLUDED.source,
                    set_at = NOW()
      RETURNING sender_email, standing, set_at, source
    `;
    return row!;
  }

  /** List all standings, optionally filtered by standing value. */
  async list(standing?: SenderStanding): Promise<SenderStandingRow[]> {
    return this.sql<SenderStandingRow[]>`
      SELECT sender_email, standing, set_at, source
      FROM google.sender_standing
      ${standing ? this.sql`WHERE standing = ${standing}` : this.sql``}
      ORDER BY set_at DESC
    `;
  }

  /** The set of whitelisted sender addresses (used to stop asking about them). */
  async whitelistedSenders(): Promise<Set<string>> {
    const rows = await this.sql<{ sender_email: string }[]>`
      SELECT sender_email FROM google.sender_standing WHERE standing = 'whitelist'
    `;
    return new Set(rows.map((r) => r.sender_email));
  }
}

/**
 * Append-only classification-refinement queue. `append` NEVER touches triage
 * rules or prompts — it only records the correction. The route that calls it is
 * responsible for the immediate, single-email placement fix.
 */
export class RefinementStore {
  constructor(private sql: postgres.Sql) {}

  /** Record a reclassification correction. Returns the new queue row. */
  async append(input: {
    emailId: number;
    fromClass: string | null;
    toClass: string;
    note?: string | null;
  }): Promise<RefinementRow> {
    const [row] = await this.sql<RefinementRow[]>`
      INSERT INTO google.classification_refinements
        (email_id, from_class, to_class, note)
      VALUES (
        ${input.emailId},
        ${input.fromClass ?? null},
        ${input.toClass},
        ${input.note ?? null}
      )
      RETURNING *
    `;
    return row!;
  }

  /** Pending refinements, oldest first — the queue an interactive session drains. */
  async listPending(): Promise<RefinementRow[]> {
    return this.sql<RefinementRow[]>`
      SELECT r.*, e.subject, e.from_address, e.from_name
      FROM google.classification_refinements r
      JOIN google.emails e ON e.id = r.email_id
      WHERE r.status = 'pending'
      ORDER BY r.created_at ASC
    `;
  }

  /** Count pending refinements (for surfacing queue depth in the briefing). */
  async pendingCount(): Promise<number> {
    const [row] = await this.sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM google.classification_refinements
      WHERE status = 'pending'
    `;
    return parseInt(row?.count ?? '0', 10);
  }

  /** Resolve a refinement with what changed (or "noted, no change"). */
  async resolve(id: number, resolution: string): Promise<RefinementRow | null> {
    const [row] = await this.sql<RefinementRow[]>`
      UPDATE google.classification_refinements
      SET status = 'resolved', resolution = ${resolution}, resolved_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return row ?? null;
  }
}
