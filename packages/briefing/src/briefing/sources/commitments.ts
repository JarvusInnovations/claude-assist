/**
 * Open-commitments source for the briefing.
 *
 * Pluggable: shells out (read-only) to any configured commitments CLI and
 * parses its stdout. The CLI is expected to emit a TOON table named
 * `commitments` with these columns (extra columns are ignored):
 *
 *   commitments[N]{slug,title,due_date,assignee,made_to,deadline_firmness}:
 *     acme-launch,Ship the launch,2026-07-15,alex,dana,firm
 *     ...
 *
 * `due_date` is an ISO date (YYYY-MM-DD) or the literal `null` when undated.
 * When no commitments source is configured the section is simply omitted; when
 * a configured source is absent or fails, the section degrades to omission
 * (error flagged) rather than failing the whole briefing.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseToonTable, rowRecord } from '../../toon.js';

const execFileAsync = promisify(execFile);

export interface OpenCommitment {
  slug: string;
  title: string;
  /** ISO date or null when undated. */
  dueDate: string | null;
  assignee: string;
  madeTo: string;
  firmness: string;
  /** true when dueDate is strictly before `todayIso`. */
  overdue: boolean;
  /** true when dueDate equals `todayIso`. */
  dueToday: boolean;
}

export interface CommitmentsResult {
  commitments: OpenCommitment[];
  error: string | null;
}

export interface FetchCommitmentsOptions {
  /** Path to the commitments CLI. When unset, the source is skipped cleanly. */
  bin?: string;
  /** Args passed to the CLI (default: ['commitment', 'list']). */
  args?: string[];
  /** YYYY-MM-DD used to flag overdue / due-today. */
  todayIso: string;
  timeoutMs?: number;
}

export async function fetchOpenCommitments(
  opts: FetchCommitmentsOptions
): Promise<CommitmentsResult> {
  const bin = opts.bin;
  // No commitments source configured — omit the section without flagging an error.
  if (!bin) {
    return { commitments: [], error: null };
  }
  const args = opts.args && opts.args.length > 0 ? opts.args : ['commitment', 'list'];
  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { commitments: parseCommitments(stdout, opts.todayIso), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { commitments: [], error: `commitments source read failed: ${message}` };
  }
}

/** Parse the commitments CLI's TOON output, annotating overdue/due-today. */
export function parseCommitments(output: string, todayIso: string): OpenCommitment[] {
  const table = parseToonTable(output, 'commitments');
  if (!table) return [];
  return table.rows.map((values) => {
    const rec = rowRecord(table.columns, values);
    const rawDue = rec.due_date ?? '';
    const dueDate = rawDue && rawDue !== 'null' ? rawDue : null;
    return {
      slug: rec.slug ?? '',
      title: rec.title ?? '',
      dueDate,
      assignee: nullish(rec.assignee),
      madeTo: nullish(rec.made_to),
      firmness: nullish(rec.deadline_firmness),
      overdue: dueDate != null && dueDate < todayIso,
      dueToday: dueDate != null && dueDate === todayIso,
    };
  });
}

function nullish(value: string | undefined): string {
  return value && value !== 'null' ? value : '';
}
