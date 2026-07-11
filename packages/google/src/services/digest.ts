/**
 * Email digests — the batch surface for everything that didn't earn an
 * interrupt (no-daily-ritual: the digest is composed and pushed on a schedule;
 * Chris confirms asynchronously, and coverage never depends on him showing up).
 *
 *   - Daily digest: triaged-but-not-executed mail grouped by digest_section,
 *     each row showing its planned action. Delivered as a `digest`-priority
 *     notification (Slack DM). Confirm-to-execute lands as a plain endpoint —
 *     `POST /api/google/emails/execute { email_ids }` — so actions apply only
 *     on Chris's confirmation. The interactive digest PAGE is deferred to the
 *     claude-assist pages surface (documented follow-up); v1 confirmation is
 *     the endpoint / CLI.
 *   - Weekly spam-quarantine digest: everything staged/moved to Gmail Spam in
 *     the last 7 days, for review. Spam is quarantined, NEVER deleted.
 *
 * Pure rendering (`renderDailyDigest`, `renderQuarantineDigest`) is separated
 * from delivery so it can be unit-tested and, later, reused by the page.
 */

import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { NotifyDispatcher } from '@jarvus/claude-assist-core';
import type { EmailAnalysis, GmailAction } from '../types.js';

export interface DigestEmailRow {
  id: number;
  account_identifier: string;
  from_address: string | null;
  from_name: string | null;
  subject: string | null;
  digest_section: string | null;
  gmail_action: string | null;
}

/**
 * Richer per-email shape for the interactive digest page — carries the
 * one-line overview (`analysis.overview`), the staged label plan, and the
 * workflow status so the page can render a review row and a per-row action
 * override. `analysis` comes back as raw JSONB (string or object) from
 * postgres.js; callers parse it before serializing.
 */
export interface DigestEmailDetail {
  id: number;
  account_identifier: string;
  from_address: string | null;
  from_name: string | null;
  subject: string | null;
  date: Date | null;
  digest_section: string | null;
  gmail_action: GmailAction | null;
  planned_labels: string[] | null;
  workflow_status: string;
  analysis: EmailAnalysis | string | null;
}

/** One digest section with its emails, in canonical section order. */
export interface DigestSectionGroup<T> {
  section: string;
  count: number;
  emails: T[];
}

const DIGEST_SECTION_ORDER = [
  'calendar',
  'financial',
  'opportunities',
  'newsletters',
  'notifications',
  'personal',
  'spam',
];

function sectionRank(section: string): number {
  const i = DIGEST_SECTION_ORDER.indexOf(section);
  return i === -1 ? DIGEST_SECTION_ORDER.length : i;
}

/**
 * Pure: bucket rows by `digest_section` (null → "other") into groups ordered
 * by the canonical DIGEST_SECTION_ORDER, then alphabetically. Shared by the
 * digest page's pending + history endpoints so section ordering is identical
 * everywhere.
 */
export function groupDigestBySection<T extends { digest_section: string | null }>(
  rows: T[]
): DigestSectionGroup<T>[] {
  const bySection = new Map<string, T[]>();
  for (const row of rows) {
    const section = row.digest_section ?? 'other';
    const list = bySection.get(section) ?? [];
    list.push(row);
    bySection.set(section, list);
  }
  return [...bySection.keys()]
    .sort((a, b) => sectionRank(a) - sectionRank(b) || a.localeCompare(b))
    .map((section) => {
      const emails = bySection.get(section)!;
      return { section, count: emails.length, emails };
    });
}

/** Pure: render the grouped daily-digest body + the id list to confirm. */
export function renderDailyDigest(rows: DigestEmailRow[]): {
  body: string;
  emailIds: number[];
} {
  const emailIds = rows.map((r) => r.id);
  if (rows.length === 0) {
    return { body: 'No staged email actions awaiting confirmation.', emailIds };
  }

  const bySection = new Map<string, DigestEmailRow[]>();
  for (const row of rows) {
    const section = row.digest_section ?? 'other';
    const list = bySection.get(section) ?? [];
    list.push(row);
    bySection.set(section, list);
  }

  const sections = [...bySection.keys()].sort(
    (a, b) => sectionRank(a) - sectionRank(b) || a.localeCompare(b)
  );

  const parts: string[] = [];
  for (const section of sections) {
    const items = bySection.get(section)!;
    const lines = items.map((r) => {
      const who = r.from_name ?? r.from_address ?? 'unknown';
      const action = r.gmail_action ?? 'leave';
      return `  • [#${r.id}] ${who} — ${r.subject ?? '(no subject)'}  →  ${action}`;
    });
    parts.push(`${section.toUpperCase()} (${items.length})\n${lines.join('\n')}`);
  }

  const footer =
    `\nConfirm to execute: POST /api/google/emails/execute {"email_ids": [...]}` +
    `\n(or \`gmail-axi execute <id>...\`). Nothing is applied until you confirm.`;

  return {
    body: `${rows.length} email action(s) staged for confirmation.\n\n${parts.join('\n\n')}\n${footer}`,
    emailIds,
  };
}

/** Pure: render the weekly spam-quarantine review body. */
export function renderQuarantineDigest(rows: DigestEmailRow[]): { body: string } {
  if (rows.length === 0) {
    return { body: 'No email quarantined to Spam in the last 7 days.' };
  }
  const lines = rows.map((r) => {
    const who = r.from_name ?? r.from_address ?? 'unknown';
    return `  • [#${r.id}] ${who} — ${r.subject ?? '(no subject)'}`;
  });
  return {
    body:
      `${rows.length} message(s) quarantined to Spam (never deleted) in the last 7 days.\n` +
      `Review and rescue any false positives:\n${lines.join('\n')}`,
  };
}

export class DigestService {
  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private notify: NotifyDispatcher | undefined;

  constructor(
    sql: postgres.Sql,
    log: FastifyBaseLogger,
    notify?: NotifyDispatcher
  ) {
    this.sql = sql;
    this.log = log;
    this.notify = notify;
  }

  /** Rows staged (triaged, not executed) with a planned action, for the daily digest. */
  async loadDailyRows(): Promise<DigestEmailRow[]> {
    return this.sql<DigestEmailRow[]>`
      SELECT e.id, a.identifier AS account_identifier,
             e.from_address, e.from_name, e.subject,
             e.digest_section, e.gmail_action
      FROM google.emails e
      JOIN google.accounts a ON e.account_id = a.id
      WHERE e.workflow_status = 'triaged'
        AND e.gmail_action IS NOT NULL
      ORDER BY e.digest_section NULLS LAST, e.date DESC
    `;
  }

  /**
   * Detailed pending rows for the interactive digest page: everything
   * triaged-or-reviewed but not yet executed that has a planned action.
   * Includes `reviewed` so a row the owner just modified (PATCH flips the
   * status to `reviewed`) stays visible until it is actually executed.
   */
  async loadPendingDetailed(): Promise<DigestEmailDetail[]> {
    return this.sql<DigestEmailDetail[]>`
      SELECT e.id, a.identifier AS account_identifier,
             e.from_address, e.from_name, e.subject, e.date,
             e.digest_section, e.gmail_action, e.planned_labels,
             e.workflow_status, e.analysis
      FROM google.emails e
      JOIN google.accounts a ON e.account_id = a.id
      WHERE e.workflow_status IN ('triaged', 'reviewed')
        AND e.gmail_action IS NOT NULL
      ORDER BY e.digest_section NULLS LAST, e.date DESC
    `;
  }

  /**
   * Recently executed rows (applied_* columns), newest first, for the page's
   * confidence-building "executed" list.
   */
  async loadRecentExecuted(days = 7): Promise<DigestEmailDetail[]> {
    const daysNum = Number.isFinite(days) && days > 0 ? Math.floor(days) : 7;
    return this.sql<DigestEmailDetail[]>`
      SELECT e.id, a.identifier AS account_identifier,
             e.from_address, e.from_name, e.subject, e.executed_at AS date,
             e.digest_section, e.applied_gmail_action AS gmail_action,
             e.applied_labels AS planned_labels,
             e.workflow_status, e.analysis
      FROM google.emails e
      JOIN google.accounts a ON e.account_id = a.id
      WHERE e.workflow_status = 'executed'
        AND e.executed_at > NOW() - INTERVAL '1 day' * ${daysNum}
      ORDER BY e.executed_at DESC
      LIMIT 100
    `;
  }

  /** Everything moved/staged to Spam in the last 7 days, for the weekly review. */
  async loadQuarantineRows(): Promise<DigestEmailRow[]> {
    return this.sql<DigestEmailRow[]>`
      SELECT e.id, a.identifier AS account_identifier,
             e.from_address, e.from_name, e.subject,
             e.digest_section, e.gmail_action
      FROM google.emails e
      JOIN google.accounts a ON e.account_id = a.id
      WHERE (e.applied_gmail_action = 'spam' OR e.gmail_action = 'spam')
        AND COALESCE(e.executed_at, e.triaged_at, e.date) > NOW() - INTERVAL '7 days'
      ORDER BY e.date DESC
    `;
  }

  /** Compose + dispatch the daily digest. Returns the staged email ids. */
  async sendDailyDigest(): Promise<number[]> {
    const rows = await this.loadDailyRows();
    if (rows.length === 0) {
      this.log.info('Daily email digest: nothing staged, skipping');
      return [];
    }
    const { body, emailIds } = renderDailyDigest(rows);
    if (this.notify) {
      await this.notify.notify({
        priority: 'digest',
        title: `Email digest — ${rows.length} action(s) to confirm`,
        body,
      });
    } else {
      this.log.warn('Daily email digest composed but no dispatcher wired');
    }
    return emailIds;
  }

  /** Compose + dispatch the weekly spam-quarantine review digest. */
  async sendQuarantineDigest(): Promise<number> {
    const rows = await this.loadQuarantineRows();
    if (rows.length === 0) {
      this.log.info('Weekly quarantine digest: nothing quarantined, skipping');
      return 0;
    }
    const { body } = renderQuarantineDigest(rows);
    if (this.notify) {
      await this.notify.notify({
        priority: 'digest',
        title: `Spam quarantine review — ${rows.length} message(s)`,
        body,
      });
    } else {
      this.log.warn('Quarantine digest composed but no dispatcher wired');
    }
    return rows.length;
  }
}
