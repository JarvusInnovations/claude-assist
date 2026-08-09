/**
 * Write the review's link into Tana.
 *
 * A deliberately thin write: a heading, the headline numbers, and the URL. The
 * review itself lives on the page — mirroring its contents into Tana would be
 * two copies of the same reconciliation, one of which is always stale. What
 * Tana gets is the *pointer*, on the day node, where the owner will actually
 * trip over it.
 *
 * Idempotent per period: a re-run finds its own marker and skips rather than
 * stacking a second block.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { TanaMcpClient } from '@jarvus/claude-assist-core';
import type { ReviewSummary } from '../types.js';
import { headline } from './compose.js';

export const REVIEW_MARKER = 'Finance review';

export function reviewHeading(periodKey: string): string {
  return `${REVIEW_MARKER} — ${periodKey}`;
}

export interface TanaLinkResult {
  dayNodeId: string;
  imported: boolean;
  skipped: boolean;
}

export class ReviewTanaWriter {
  constructor(
    private client: TanaMcpClient,
    private workspaceId: string,
    private log: FastifyBaseLogger,
  ) {}

  /** `dateIso` is the day the review was produced, not the period it covers. */
  async write(summary: ReviewSummary, pageUrl: string | null, dateIso: string): Promise<TanaLinkResult> {
    const dayNodeId = extractNodeId(
      await this.client.callTool('get_or_create_calendar_node', {
        workspaceId: this.workspaceId,
        granularity: 'day',
        date: dateIso,
      }),
    );
    if (!dayNodeId) throw new Error('get_or_create_calendar_node returned no day node id');

    if (await this.alreadyPresent(dayNodeId, summary.periodKey)) {
      this.log.info({ dayNodeId, period: summary.periodKey }, 'Finance review already linked in Tana');
      return { dayNodeId, imported: false, skipped: true };
    }

    await this.client.callTool('import_tana_paste', {
      parentNodeId: dayNodeId,
      content: renderTanaPaste(summary, pageUrl),
    });
    return { dayNodeId, imported: true, skipped: false };
  }

  private async alreadyPresent(dayNodeId: string, periodKey: string): Promise<boolean> {
    try {
      const text = await this.client.callTool('get_children', { nodeId: dayNodeId, limit: 200 });
      return text.includes(reviewHeading(periodKey));
    } catch (err) {
      // A failed read must not block the write; worst case is a duplicate block.
      this.log.warn({ err, dayNodeId }, 'Could not read day-node children for dedup — proceeding');
      return false;
    }
  }
}

/** Pure: summary → Tana Paste. Tested in isolation. */
export function renderTanaPaste(summary: ReviewSummary, pageUrl: string | null): string {
  const lines = [`- ${reviewHeading(summary.periodKey)}`, `  - ${headline(summary)}`];
  if (pageUrl) lines.push(`  - Open the review: ${pageUrl}`);
  lines.push(
    `  - Out ${summary.totalOutflow.toFixed(2)} ${summary.currency}, in ${summary.totalInflow.toFixed(2)} ${summary.currency}`,
  );
  if (summary.uncategorized.length > 0) {
    lines.push(`  - ${summary.uncategorized.length} uncategorized transactions`);
  }
  return lines.join('\n');
}

/** Best-effort id extraction from a tool's text response. */
export function extractNodeId(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ['nodeId', 'id', 'node_id']) {
        if (typeof record[key] === 'string') return record[key] as string;
      }
    }
  } catch {
    // Not JSON — fall through to the regex.
  }
  const match = /\b([A-Za-z0-9_-]{8,})\b/.exec(text);
  return match?.[1] ?? '';
}

/** Deep link to a Tana node, for the notification's action button. */
export function tanaNodeLink(nodeId: string | null): string | undefined {
  return nodeId ? `https://app.tana.inc/?nodeid=${encodeURIComponent(nodeId)}` : undefined;
}
