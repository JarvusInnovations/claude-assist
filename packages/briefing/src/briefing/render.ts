/**
 * Render a composed briefing into the Tana day node.
 *
 * `renderTanaPaste` is a pure Briefing → Tana Paste string (tested in isolation).
 * `BriefingRenderer` handles the side-effecting write: get-or-create the exact
 * day node for the target date (granularity=day — the ONLY calendar-node call,
 * so no stray week/month/year nodes), then, guarding against duplicate briefing
 * blocks on re-run, import the paste under it.
 *
 * Hygiene: we never call get_or_create_calendar_node speculatively, we target
 * one date, and we read the day node's children first so a second run of the
 * day doesn't stack a second briefing (idempotent per date).
 */

import type { FastifyBaseLogger } from 'fastify';
import type { TanaMcpClient } from '@jarvus/claude-assist-core';
import type { Briefing } from './compose.js';
import type { OpenCommitment } from './sources/commitments.js';
import type { EmailBrief } from './sources/email.js';
import type { AlertPlanItem } from '../types.js';

/** Stable marker so a per-date briefing block is found + not duplicated. */
export const BRIEFING_MARKER = 'Morning Briefing';

export function briefingHeading(dateIso: string): string {
  return `${BRIEFING_MARKER} — ${dateIso}`;
}

export interface RenderResult {
  dayNodeId: string;
  imported: boolean;
  /** true when an existing briefing block for the date was found → import skipped. */
  skipped: boolean;
}

export class BriefingRenderer {
  constructor(
    private client: TanaMcpClient,
    private workspaceId: string,
    private log: FastifyBaseLogger
  ) {}

  async render(briefing: Briefing): Promise<RenderResult> {
    const dayNodeId = await this.getDayNode(briefing.dateIso);
    if (!dayNodeId) {
      throw new Error('get_or_create_calendar_node returned no day node id');
    }

    if (await this.hasExistingBriefing(dayNodeId, briefing.dateIso)) {
      this.log.info({ dayNodeId, date: briefing.dateIso }, 'Briefing already present for date — skipping import');
      return { dayNodeId, imported: false, skipped: true };
    }

    await this.client.callTool('import_tana_paste', {
      parentNodeId: dayNodeId,
      content: renderTanaPaste(briefing),
    });
    return { dayNodeId, imported: true, skipped: false };
  }

  private async getDayNode(dateIso: string): Promise<string> {
    const text = await this.client.callTool('get_or_create_calendar_node', {
      workspaceId: this.workspaceId,
      granularity: 'day',
      date: dateIso,
    });
    return extractNodeId(text);
  }

  private async hasExistingBriefing(dayNodeId: string, dateIso: string): Promise<boolean> {
    try {
      const text = await this.client.callTool('get_children', { nodeId: dayNodeId, limit: 200 });
      const heading = briefingHeading(dateIso);
      // The tool returns JSON text; be permissive about its exact shape.
      return text.includes(heading);
    } catch (err) {
      // A read failure shouldn't block the write; log and proceed (may duplicate).
      this.log.warn({ err, dayNodeId }, 'Could not read day-node children for dedup — proceeding');
      return false;
    }
  }
}

/** Extract a node id from get_or_create_calendar_node's text result. */
export function extractNodeId(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  // JSON shapes: {"nodeId":"..."} or {"id":"..."} or a bare quoted string.
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const key of ['nodeId', 'id', 'node_id']) {
        if (typeof obj[key] === 'string') return obj[key] as string;
      }
    }
  } catch {
    // not JSON — fall through
  }
  // Bare id: take the first whitespace-delimited token.
  return trimmed.split(/\s+/)[0] ?? '';
}

/**
 * Pure Briefing → Tana Paste. Deliberately plain: no supertags (applying unknown
 * tags could mutate Tana schema — same rule the capture executor follows). One
 * parent heading, section bullets, nested detail. Sections whose source failed
 * render a "not available" line rather than vanishing.
 */
export function renderTanaPaste(b: Briefing): string {
  const lines: string[] = [];
  lines.push(`- ${briefingHeading(b.dateIso)}`);
  lines.push(`  - ${b.headline}`);

  // Calendar
  lines.push('  - Today');
  if (b.calendar.error) {
    lines.push(`    - Calendar not available: ${b.calendar.error}`);
  } else if (b.calendar.events.length === 0) {
    lines.push('    - No events on the calendar');
  } else {
    for (const e of b.calendar.events) {
      const when = e.allDay ? 'all-day' : timeOf(e.start);
      const willAlert = b.calendar.alerting.some((a) => a.event.id === e.id);
      const flag = willAlert ? ' [will alert]' : '';
      lines.push(`    - ${when} · ${e.summary || '(untitled)'}${flag}`);
    }
  }

  // Which events will alert today (explicit sub-list per the plan)
  lines.push('  - Join alerts today');
  if (b.calendar.alerting.length === 0) {
    lines.push('    - None scheduled');
  } else {
    for (const item of b.calendar.alerting) {
      lines.push(`    - ${alertLine(item)}`);
    }
  }

  // Commitments
  lines.push('  - Open commitments');
  if (b.commitments.error) {
    lines.push(`    - Commitments not available: ${b.commitments.error}`);
  } else {
    if (b.commitments.overdue.length > 0) {
      lines.push(`    - Overdue (${b.commitments.overdue.length})`);
      for (const c of b.commitments.overdue) lines.push(`      - ${commitmentLine(c)}`);
    }
    if (b.commitments.dueToday.length > 0) {
      lines.push(`    - Due today (${b.commitments.dueToday.length})`);
      for (const c of b.commitments.dueToday) lines.push(`      - ${commitmentLine(c)}`);
    }
    if (b.commitments.upcomingCount > 0) {
      lines.push(`    - ${b.commitments.upcomingCount} more open (upcoming / undated)`);
    }
    if (
      b.commitments.overdue.length === 0 &&
      b.commitments.dueToday.length === 0 &&
      b.commitments.upcomingCount === 0
    ) {
      lines.push('    - None open');
    }
  }

  // Email — two tiers: what earned attention, then a calm aggregate.
  lines.push('  - Email');
  if (b.email.error) {
    lines.push(`    - Email summary not available: ${b.email.error}`);
  } else {
    if (b.email.needsAttention.length > 0) {
      lines.push(`    - Needs attention (${b.email.needsAttention.length})`);
      for (const m of b.email.needsAttention) lines.push(`      - ${emailLine(m)}`);
    } else {
      lines.push('    - Needs attention: none');
    }

    if (b.email.otherHumanCount > 0) {
      lines.push(`    - Other human mail (${b.email.otherHumanCount})`);
      // List individually only when the bucket is small; otherwise roll up.
      if (b.email.otherHumanCount <= 3 && b.email.otherHuman.length > 0) {
        for (const m of b.email.otherHuman) lines.push(`      - ${emailLine(m)}`);
      } else if (b.email.otherTopSenders.length > 0) {
        const top = b.email.otherTopSenders
          .map((s) => (s.count > 1 ? `${s.name} (${s.count})` : s.name))
          .join(', ');
        lines.push(`      - Top senders: ${top}`);
      }
    }

    if (b.email.untriagedCount > 0) {
      lines.push(`    - ${b.email.untriagedCount} awaiting triage`);
    }
  }

  // Captures
  lines.push('  - Captures awaiting review');
  if (b.captures.error) {
    lines.push(`    - Capture queue not available: ${b.captures.error}`);
  } else {
    lines.push(
      `    - ${b.captures.awaitingReview} awaiting review · ${b.captures.awaitingExecutor} parked (no executor)`
    );
  }

  // Coverage / pipeline health
  lines.push('  - Pipeline health');
  if (b.coverage.error) {
    lines.push(`    - Coverage summary not available: ${b.coverage.error}`);
  } else {
    const stale = b.coverage.pipelines.filter((p) => p.stale);
    if (stale.length === 0) {
      lines.push(`    - All ${b.coverage.pipelines.length} pipelines fresh`);
    } else {
      lines.push(`    - ${stale.length} stale`);
      for (const p of stale) {
        const age = p.ageHours == null ? 'never succeeded' : `${p.ageHours.toFixed(1)}h`;
        lines.push(`      - ${p.name}: ${age} (${p.ratio.toFixed(1)}× threshold)`);
      }
    }
  }

  // Links out
  if (b.links.length > 0) {
    lines.push('  - More');
    for (const link of b.links) lines.push(`    - ${link.label}: ${link.url}`);
  }

  return lines.join('\n');
}

/** Max chars of the stored overview embedded per email (keeps bullets tidy). */
const EMAIL_OVERVIEW_MAX = 140;

function emailLine(m: EmailBrief): string {
  const head = `${m.fromName}: ${m.subject}`;
  const overview = collapseWhitespace(m.overview);
  if (!overview) return head;
  return `${head} — ${truncate(overview, EMAIL_OVERVIEW_MAX)}`;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function commitmentLine(c: OpenCommitment): string {
  const due = c.dueDate ? c.dueDate : 'undated';
  const to = c.madeTo ? ` → ${c.madeTo}` : '';
  return `${c.title} (${due})${to}`;
}

function alertLine(item: AlertPlanItem): string {
  const fire = item.fireAtMs != null ? timeOfMs(item.fireAtMs) : '—';
  const start = item.event.allDay ? 'all-day' : timeOf(item.event.start);
  const via = item.classification.venue === 'physical' ? 'in-person' : 'video';
  return `${fire} → ${item.event.summary || '(untitled)'} (starts ${start}, ${via}, ${item.leadMinutes}m lead)`;
}

function timeOf(iso: string): string {
  return iso.includes('T') ? iso.slice(11, 16) : iso;
}

function timeOfMs(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
