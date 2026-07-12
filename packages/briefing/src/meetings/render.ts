/**
 * Render a prep into Tana.
 *
 * TARGET CHOICE (documented deliberately): the tana-local MCP exposes day
 * calendar nodes (`get_or_create_calendar_node`, granularity=day) and generic
 * node ops, but no first-class "locate this meeting's node" affordance — Tana's
 * meeting nodes are created by the owner's own calendar integration and matching
 * one by fuzzy title/time is unreliable. Per the plan's fallback guidance, we
 * therefore render into the OCCURRENCE'S DAY NODE under a clearly-marked,
 * stable meeting-prep heading that names the meeting + its start time. This
 * mirrors the daily briefing's day-node approach and its heading-dedup
 * idempotency. (Attaching under an existing Tana meeting node is a documented
 * follow-on once the MCP grows a reliable locate-by-occurrence call.)
 *
 * Idempotency: the heading is stable per occurrence. First delivery imports it.
 * A refresh trashes the prior block (best-effort — needs get_children to yield
 * node ids) then re-imports, so the prep updates in place; if the prior block's
 * id can't be parsed, the refresh is skipped rather than duplicated, and that's
 * logged.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { TanaMcpClient } from '@jarvus/claude-assist-core';
import type { MeetingPrep } from './types.js';
import { extractNodeId } from '../briefing/render.js';

/** Stable marker so a per-occurrence prep block is found + not duplicated. */
export const PREP_MARKER = 'Meeting Prep';

/** Heading for one occurrence: marker + summary + start (identifies the occurrence). */
export function prepHeading(prep: MeetingPrep): string {
  const when = prep.occurrenceStart ? prep.occurrenceStart.slice(0, 16).replace('T', ' ') : 'unscheduled';
  return `${PREP_MARKER} — ${prep.summary || '(untitled)'} — ${when}`;
}

/** `YYYY-MM-DD` of the occurrence (the day node to target), or null. */
export function prepDateIso(prep: MeetingPrep): string | null {
  if (!prep.occurrenceStart) return null;
  const ms = Date.parse(prep.occurrenceStart);
  if (Number.isNaN(ms)) return prep.occurrenceStart.slice(0, 10) || null;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Pure MeetingPrep → Tana Paste. One parent heading node, the prep body nested
 * beneath, and an optional link-out line. Plain bullets only (no supertags —
 * same rule the daily briefing + capture executor follow). `prepContent` is
 * already a bullet outline; it's re-indented one level under the heading.
 */
export function renderPrepPaste(prep: MeetingPrep, pageBaseUrl?: string | null): string {
  const lines: string[] = [];
  lines.push(`- ${prepHeading(prep)}`);
  const body = (prep.prepContent ?? '').split('\n').filter((l) => l.trim().length > 0);
  if (body.length === 0) {
    lines.push('  - (no prep content)');
  } else {
    for (const l of body) lines.push(`  ${l.startsWith('- ') || l.startsWith(' ') ? l : `- ${l}`}`);
  }
  if (pageBaseUrl) {
    const root = pageBaseUrl.replace(/\/+$/, '');
    lines.push(`  - Full prep: ${root}/meetings/${encodeURIComponent(prep.occurrenceKey)}`);
  }
  return lines.join('\n');
}

export interface PrepRenderResult {
  dayNodeId: string;
  imported: boolean;
  /** true when a refresh replaced an existing block. */
  replaced: boolean;
}

export class MeetingPrepRenderer {
  constructor(
    private client: TanaMcpClient,
    private workspaceId: string,
    private log: FastifyBaseLogger
  ) {}

  /**
   * Render `prep` into its day node. When `replaceExisting` (a refresh), trash a
   * prior block for the same occurrence first so the prep updates in place.
   */
  async render(prep: MeetingPrep, opts: { replaceExisting?: boolean; pageBaseUrl?: string | null } = {}): Promise<PrepRenderResult> {
    const dateIso = prepDateIso(prep);
    if (!dateIso) throw new Error('prep has no resolvable occurrence date');

    const dayNodeId = await this.getDayNode(dateIso);
    if (!dayNodeId) throw new Error('get_or_create_calendar_node returned no day node id');

    const existingId = await this.findExistingBlockId(dayNodeId, prep);

    let replaced = false;
    if (existingId) {
      if (!opts.replaceExisting) {
        // First-delivery path: block already present (e.g. a prior run) — don't duplicate.
        this.log.info({ dayNodeId, occurrence: prep.occurrenceKey }, 'Prep block already present — skipping import');
        return { dayNodeId, imported: false, replaced: false };
      }
      try {
        await this.client.callTool('trash_node', { nodeId: existingId });
        replaced = true;
      } catch (err) {
        this.log.warn({ err, existingId }, 'Could not trash prior prep block — skipping refresh render to avoid a duplicate');
        return { dayNodeId, imported: false, replaced: false };
      }
    }

    await this.client.callTool('import_tana_paste', {
      parentNodeId: dayNodeId,
      content: renderPrepPaste(prep, opts.pageBaseUrl),
    });
    return { dayNodeId, imported: true, replaced };
  }

  private async getDayNode(dateIso: string): Promise<string> {
    const text = await this.client.callTool('get_or_create_calendar_node', {
      workspaceId: this.workspaceId,
      granularity: 'day',
      date: dateIso,
    });
    return extractNodeId(text);
  }

  /**
   * Find the node id of an existing prep block for this occurrence under the day
   * node. Parses get_children defensively (its exact JSON shape isn't
   * guaranteed): looks for a child whose text/name contains the occurrence's
   * heading and returns its id when present. Returns null on any miss or parse
   * failure (caller then imports fresh / skips-if-present).
   */
  private async findExistingBlockId(dayNodeId: string, prep: MeetingPrep): Promise<string | null> {
    const heading = prepHeading(prep);
    let text: string;
    try {
      text = await this.client.callTool('get_children', { nodeId: dayNodeId, limit: 200 });
    } catch (err) {
      this.log.warn({ err, dayNodeId }, 'Could not read day-node children — treating as no existing prep');
      return null;
    }
    return findChildIdByHeading(text, heading);
  }
}

/**
 * Extract the id of a child node whose text contains `heading` from a
 * get_children result. Handles the common shapes (array of {id,name|text} under
 * a wrapper key or at top level); returns null when it can't confidently match.
 * Exported for tests.
 */
export function findChildIdByHeading(text: string, heading: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const children = extractChildArray(parsed);
  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    const c = child as Record<string, unknown>;
    const label =
      (typeof c.name === 'string' && c.name) ||
      (typeof c.text === 'string' && c.text) ||
      (typeof c.title === 'string' && c.title) ||
      '';
    if (label.includes(heading)) {
      for (const key of ['id', 'nodeId', 'node_id']) {
        if (typeof c[key] === 'string') return c[key] as string;
      }
    }
  }
  return null;
}

function extractChildArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['children', 'nodes', 'items', 'result']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}
