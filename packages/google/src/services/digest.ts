/**
 * Email digest v2 — the priority-first dashboard surface (behavior:
 * email-digest). Everything triage classified since the last digest is
 * presented once a day as an ordered dashboard the owner processes in one pass:
 *
 *   1. ACTIONABLE   — needs-response / needs-decision mail, individually listed
 *                     (sender-kind icon, sender, one-line gist, date, planned
 *                     action). The confirm-to-execute set.
 *   2. digest categories (calendar, financial, opportunities, newsletters) —
 *                     each a CONTENT SUMMARY of the set (what happened, not who
 *                     sent what), summary bullets written at digest time by a
 *                     Haiku-class model. Expandable to the underlying emails.
 *   3. ARCHIVE      — routine auto-archived mail, one-liner each.
 *   4. SPAM         — quarantined mail, count + terse one-liners.
 *
 * Ordering is a property of the medium: a web page reads top-down, so it runs
 * priority-first (this order). The section list and the two render modes are
 * inherited from the proven v1 text digest. Sections with nothing are omitted.
 *
 * Assembly (`bucketDigestSections`) is pure so ordering/render-modes/rollover
 * are unit-testable without a DB or a model; the summary bullets are filled by
 * an injected `DigestSummarizer` (Haiku — summarizing, not judging), with a
 * deterministic fallback when no model is wired.
 *
 * Delivery is a Pushover notice: the title carries headline counts and the
 * button opens the interactive page. The weekly spam-quarantine review is a
 * second Pushover notice.
 */

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { ModelInvoker, NotifyDispatcher } from '@jarvus/claude-assist-core';
import type { EmailAnalysis, GmailAction } from '../types.js';
import type { SenderStandingStore } from './standing.js';

export type DigestRenderMode = 'summary' | 'listed';
export type SenderKind = 'human' | 'automated';

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
 * Richer per-email shape backing the interactive page. `analysis` comes back as
 * raw JSONB (string or object) from postgres.js; callers parse it before
 * assembly. `triaged_at` drives the actionable rollover age marker.
 */
export interface DigestEmailDetail {
  id: number;
  account_identifier: string;
  from_address: string | null;
  from_name: string | null;
  subject: string | null;
  date: Date | string | null;
  digest_section: string | null;
  gmail_action: GmailAction | null;
  planned_labels: string[] | null;
  workflow_status: string;
  triaged_at: Date | string | null;
  analysis: EmailAnalysis | string | null;
}

/** One assembled email in a section, carrying everything the page row needs. */
export interface DigestItem {
  id: number;
  account_identifier: string;
  from_address: string | null;
  from_name: string | null;
  subject: string | null;
  date: Date | string | null;
  gist: string | null;
  sender_kind: SenderKind;
  planned_action: GmailAction;
  planned_labels: string[] | null;
  digest_section: string | null;
  workflow_status: string;
  /** Newsletter sender — eligible for the whitelist / queue-unsubscribe taps. */
  is_newsletter: boolean;
  /** Days since triaged (actionable rollover); null when not yet triaged. */
  age_days: number | null;
  /** True when this actionable item is carrying over from an earlier digest. */
  rolled_over: boolean;
}

/** An assembled digest section: its render mode, count, summary + items. */
export interface DigestSectionPayload {
  key: string;
  title: string;
  render: DigestRenderMode;
  count: number;
  /** Content-summary bullets (summary sections only); null until filled. */
  summary: string[] | null;
  items: DigestItem[];
}

// Priority-first section order for a top-down web page.
const SECTION_ORDER = [
  'actionable',
  'calendar',
  'financial',
  'opportunities',
  'newsletters',
  'archive',
  'spam',
];

// Sections rendered as a content summary of the set (skim-and-move-on); every
// other section is individually listed (act-per-item / one-liner).
const SUMMARY_SECTIONS = new Set([
  'calendar',
  'financial',
  'opportunities',
  'newsletters',
]);

const SECTION_TITLES: Record<string, string> = {
  actionable: 'Actionable',
  calendar: 'Calendar',
  financial: 'Financial',
  opportunities: 'Opportunities',
  newsletters: 'Newsletters',
  archive: 'Archive',
  spam: 'Spam / quarantined',
};

function sectionRank(section: string): number {
  const i = SECTION_ORDER.indexOf(section);
  return i === -1 ? SECTION_ORDER.length : i;
}

function renderModeFor(section: string): DigestRenderMode {
  return SUMMARY_SECTIONS.has(section) ? 'summary' : 'listed';
}

function titleFor(section: string): string {
  return SECTION_TITLES[section] ?? section.charAt(0).toUpperCase() + section.slice(1);
}

/** Parse a JSONB analysis that may arrive as a string from postgres.js. */
function parseAnalysis(value: EmailAnalysis | string | null): EmailAnalysis | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as EmailAnalysis;
    } catch {
      return null;
    }
  }
  return value;
}

/**
 * True when a staged plan carries an action tag (`.../Respond` or `.../Review`),
 * i.e. the email needs a human reply/decision. Prefix-agnostic (the TODO tree
 * prefix is per-account) — matches the leaf segment only.
 */
export function hasActionTag(plannedLabels: string[] | null): boolean {
  return (plannedLabels ?? []).some((l) => /\/(respond|review)$/i.test(l));
}

/** Which priority-first section a row belongs to. */
export function sectionForRow(row: {
  gmail_action: GmailAction | null;
  planned_labels: string[] | null;
  digest_section: string | null;
}): string {
  if (row.gmail_action === 'spam') return 'spam';
  if (hasActionTag(row.planned_labels)) return 'actionable';
  const ds = row.digest_section ?? '';
  if (SUMMARY_SECTIONS.has(ds)) return ds;
  return 'archive';
}

function ageDays(triagedAt: Date | string | null, now: Date): number | null {
  if (!triagedAt) return null;
  const t = triagedAt instanceof Date ? triagedAt : new Date(triagedAt);
  if (isNaN(t.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - t.getTime()) / 86_400_000));
}

function toItem(row: DigestEmailDetail, section: string, now: Date): DigestItem {
  const analysis = parseAnalysis(row.analysis);
  const age = ageDays(row.triaged_at, now);
  return {
    id: row.id,
    account_identifier: row.account_identifier,
    from_address: row.from_address,
    from_name: row.from_name,
    subject: row.subject,
    date: row.date,
    gist: analysis?.overview ?? null,
    sender_kind: analysis?.sender_type === 'human' ? 'human' : 'automated',
    planned_action: row.gmail_action ?? 'leave',
    planned_labels: row.planned_labels,
    digest_section: row.digest_section,
    workflow_status: row.workflow_status,
    is_newsletter:
      analysis?.message_type === 'newsletter' || section === 'newsletters',
    age_days: age,
    // Only actionable items "roll over" — the rest are informational.
    rolled_over: section === 'actionable' && age !== null && age >= 1,
  };
}

/**
 * Pure: bucket detailed rows into priority-first sections with per-section
 * render mode, dropping empty sections. Summary bullets are left null for the
 * summarizer to fill. Deterministic given `now` (for the rollover age marker).
 */
export function bucketDigestSections(
  rows: DigestEmailDetail[],
  now: Date = new Date()
): DigestSectionPayload[] {
  const bySection = new Map<string, DigestItem[]>();
  for (const row of rows) {
    const section = sectionForRow(row);
    const list = bySection.get(section) ?? [];
    list.push(toItem(row, section, now));
    bySection.set(section, list);
  }
  return [...bySection.keys()]
    .sort((a, b) => sectionRank(a) - sectionRank(b) || a.localeCompare(b))
    .map((key) => ({
      key,
      title: titleFor(key),
      render: renderModeFor(key),
      count: bySection.get(key)!.length,
      summary: null,
      items: bySection.get(key)!,
    }));
}

/** Headline counts for the digest notification title. */
export function digestHeadline(sections: DigestSectionPayload[]): {
  needResponse: number;
  toConfirm: number;
  title: string;
} {
  const needResponse =
    sections.find((s) => s.key === 'actionable')?.count ?? 0;
  const toConfirm = sections.reduce((n, s) => n + s.count, 0);
  return {
    needResponse,
    toConfirm,
    title: `Digest · ${needResponse} need response · ${toConfirm} to confirm`,
  };
}

function itemLine(i: DigestItem): string {
  const who = i.from_name ?? i.from_address ?? 'unknown';
  const icon = i.sender_kind === 'human' ? '👤' : '🤖';
  const age = i.rolled_over ? ` (${i.age_days}d)` : '';
  return `${icon} ${who}${age} — ${i.subject ?? '(no subject)'} → ${i.planned_action}`;
}

/**
 * Short notification body: one line per section — its summary lead for summary
 * sections, else its count. Kept to a notification-shade length.
 */
export function renderDigestNotificationBody(
  sections: DigestSectionPayload[]
): string {
  if (sections.length === 0) return 'Nothing staged — triage is keeping up.';
  return sections
    .map((s) => {
      if (s.render === 'summary' && s.summary && s.summary.length > 0) {
        return `${s.title} (${s.count}): ${s.summary[0]}`;
      }
      return `${s.title}: ${s.count}`;
    })
    .join('\n');
}

/** Deterministic fallback bullets when no model summarizer is wired. */
export function fallbackSummary(items: DigestItem[]): string[] {
  return items.slice(0, 6).map(itemLine);
}

/** Injected model summarizer for summary-mode sections. */
export interface DigestSummarizer {
  summarize(section: string, items: DigestItem[]): Promise<string[]>;
}

/**
 * Stable cache key for a section's summary: the section key + the sorted item
 * membership. Membership (ids) is what the summary is *of* — a set that hasn't
 * changed should reuse its bullets rather than re-spend a model call and
 * pick up rephrasing jitter on every page load.
 */
export function summaryCacheKey(section: string, items: DigestItem[]): string {
  const ids = items.map((i) => i.id).sort((a, b) => a - b);
  return createHash('sha256')
    .update(`${section}:${ids.join(',')}`)
    .digest('hex');
}

/**
 * Decorator: caches any DigestSummarizer's bullets keyed on section + item
 * membership, so an unchanged set costs zero model calls on repeat assembly
 * (the pending page re-assembles on every request). Small bounded LRU —
 * in-memory only; a server restart cold-starts it, which is fine (the next
 * assembly just regenerates). The deterministic fallback path in
 * `fillSummaries` bypasses this entirely (no summarizer → no cache).
 */
export class CachingSummarizer implements DigestSummarizer {
  /** insertion-ordered Map used as an LRU: get re-inserts, evict from front. */
  private cache = new Map<string, string[]>();

  constructor(
    private inner: DigestSummarizer,
    private maxEntries = 32
  ) {}

  async summarize(section: string, items: DigestItem[]): Promise<string[]> {
    const key = summaryCacheKey(section, items);
    const hit = this.cache.get(key);
    if (hit) {
      // Refresh recency.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const bullets = await this.inner.summarize(section, items);
    this.cache.set(key, bullets);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    return bullets;
  }
}

/**
 * Fill the `summary` bullets of every summary-mode section (in place) via the
 * summarizer, falling back to deterministic lines when none is wired. Listed
 * sections are left untouched (their `summary` stays null). Returns the same
 * array for chaining. Pure w.r.t. the DB — unit-testable with a fake summarizer.
 */
export async function fillSummaries(
  sections: DigestSectionPayload[],
  summarizer?: DigestSummarizer
): Promise<DigestSectionPayload[]> {
  await Promise.all(
    sections
      .filter((s) => s.render === 'summary')
      .map(async (s) => {
        s.summary = summarizer
          ? await summarizer.summarize(s.key, s.items)
          : fallbackSummary(s.items);
      })
  );
  return sections;
}

/**
 * Haiku-class summarizer: turns a set of routine emails into a few terse
 * "what happened" bullets. It summarizes; it never re-judges classification.
 */
export class AnthropicDigestSummarizer implements DigestSummarizer {
  private invoker: ModelInvoker;
  private model: string | undefined;
  private maxTokens: number;

  constructor(config: {
    /** The single metered-model choke point (specs/modules/invoker.md). */
    invoker: ModelInvoker;
    /** Pin a model for this call site. Prefer moving the tier instead. */
    model?: string;
    maxTokens?: number;
  }) {
    this.invoker = config.invoker;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 512;
  }

  async summarize(section: string, items: DigestItem[]): Promise<string[]> {
    if (items.length === 0) return [];
    const lines = items
      .map((i) => {
        const who = i.from_name ?? i.from_address ?? 'unknown';
        return `- from ${who}: ${i.subject ?? '(no subject)'}${i.gist ? ` — ${i.gist}` : ''}`;
      })
      .join('\n');

    const prompt =
      `You are summarizing a batch of "${section}" emails for a daily digest.\n` +
      `Write 2-5 terse bullet points describing WHAT HAPPENED across the set — ` +
      `the substance (amounts, dates, deadlines, decisions, who is involved), ` +
      `NOT a per-email "who sent what" list. Preserve load-bearing detail ` +
      `(dollar amounts, dates, names) exactly. One bullet per line, starting ` +
      `with "- ". No preamble.\n\nEmails:\n${lines}`;

    try {
      const res = await this.invoker.invoke({
        task: 'google.digest',
        tier: 'classify',
        maxTokens: this.maxTokens,
        ...(this.model ? { model: this.model } : {}),
        messages: [{ role: 'user', content: prompt }],
      });
      const bullets = res.text
        .split('\n')
        .map((l) => l.replace(/^[-*•]\s*/, '').trim())
        .filter(Boolean);
      return bullets.length > 0 ? bullets : fallbackSummary(items);
    } catch {
      // Never let a summarization hiccup drop the section — fall back.
      return fallbackSummary(items);
    }
  }
}

export class DigestService {
  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private notify: NotifyDispatcher | undefined;
  private summarizer: DigestSummarizer | undefined;
  private standing: SenderStandingStore | undefined;
  private pageUrl: string | undefined;

  constructor(
    sql: postgres.Sql,
    log: FastifyBaseLogger,
    notify?: NotifyDispatcher,
    opts: {
      summarizer?: DigestSummarizer;
      standing?: SenderStandingStore;
      pageUrl?: string;
    } = {}
  ) {
    this.sql = sql;
    this.log = log;
    this.notify = notify;
    this.summarizer = opts.summarizer;
    this.standing = opts.standing;
    this.pageUrl = opts.pageUrl;
  }

  /**
   * Detailed pending rows for the digest: everything triaged-or-reviewed but
   * not yet executed that has a planned action. Whitelisted senders are
   * filtered out — they have standing and stop being asked. `reviewed` stays
   * visible so a row the owner just modified persists until it is executed.
   */
  async loadPendingDetailed(): Promise<DigestEmailDetail[]> {
    return this.sql<DigestEmailDetail[]>`
      SELECT e.id, a.identifier AS account_identifier,
             e.from_address, e.from_name, e.subject, e.date,
             e.digest_section, e.gmail_action, e.planned_labels,
             e.workflow_status, e.triaged_at, e.analysis
      FROM google.emails e
      JOIN google.accounts a ON e.account_id = a.id
      LEFT JOIN google.sender_standing s
        ON s.sender_email = lower(e.from_address) AND s.standing = 'whitelist'
      WHERE e.workflow_status IN ('triaged', 'reviewed')
        AND e.gmail_action IS NOT NULL
        AND s.sender_email IS NULL
      ORDER BY e.digest_section NULLS LAST, e.date DESC
    `;
  }

  /**
   * Assemble the priority-first sections and fill summary-mode bullets via the
   * summarizer (falling back to deterministic lines when none is wired).
   */
  async assemble(now: Date = new Date()): Promise<DigestSectionPayload[]> {
    const rows = await this.loadPendingDetailed();
    const sections = bucketDigestSections(rows, now);
    return fillSummaries(sections, this.summarizer);
  }

  /** Recently executed rows for the page's confidence-building history list. */
  async loadRecentExecuted(days = 7): Promise<DigestEmailDetail[]> {
    const daysNum = Number.isFinite(days) && days > 0 ? Math.floor(days) : 7;
    return this.sql<DigestEmailDetail[]>`
      SELECT e.id, a.identifier AS account_identifier,
             e.from_address, e.from_name, e.subject, e.executed_at AS date,
             e.digest_section, e.applied_gmail_action AS gmail_action,
             e.applied_labels AS planned_labels,
             e.workflow_status, e.triaged_at, e.analysis
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

  /**
   * Compose + dispatch the daily digest as a Pushover notice: headline counts
   * in the title, a few summary lines in the body, the page in the button slot.
   * Returns the staged email ids.
   */
  async sendDailyDigest(): Promise<number[]> {
    const sections = await this.assemble();
    const emailIds = sections.flatMap((s) => s.items.map((i) => i.id));
    if (emailIds.length === 0) {
      this.log.info('Daily email digest: nothing staged, skipping');
      return [];
    }
    const { title } = digestHeadline(sections);
    const body = renderDigestNotificationBody(sections);
    if (this.notify) {
      await this.notify.notify({
        priority: 'notice',
        title,
        body,
        url: this.pageUrl,
        urlTitle: this.pageUrl ? 'Open digest' : undefined,
      });
    } else {
      this.log.warn('Daily email digest composed but no dispatcher wired');
    }
    return emailIds;
  }

  /** Compose + dispatch the weekly spam-quarantine review as a Pushover notice. */
  async sendQuarantineDigest(): Promise<number> {
    const rows = await this.loadQuarantineRows();
    if (rows.length === 0) {
      this.log.info('Weekly quarantine digest: nothing quarantined, skipping');
      return 0;
    }
    const preview = rows
      .slice(0, 5)
      .map((r) => `• ${r.from_name ?? r.from_address ?? 'unknown'} — ${r.subject ?? '(no subject)'}`)
      .join('\n');
    if (this.notify) {
      await this.notify.notify({
        priority: 'notice',
        title: `Spam quarantine review · ${rows.length} message(s)`,
        body: `Quarantined to Spam (never deleted) in the last 7 days:\n${preview}`,
        url: this.pageUrl,
        urlTitle: this.pageUrl ? 'Open digest' : undefined,
      });
    } else {
      this.log.warn('Quarantine digest composed but no dispatcher wired');
    }
    return rows.length;
  }
}
