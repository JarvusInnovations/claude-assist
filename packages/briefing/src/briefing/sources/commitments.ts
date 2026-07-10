/**
 * Open-commitments source for the briefing.
 *
 * Reads HQ (the system of record) read-only via the `hq-axi` skill CLI —
 * `hq-axi commitment list` emits the same TOON table format the calendar reader
 * parses. Absent or failing, the section degrades to omission (error flagged)
 * rather than failing the whole briefing.
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
  /** Path to the hq-axi CLI (default: `hq-axi` on PATH). */
  bin?: string;
  /** YYYY-MM-DD used to flag overdue / due-today. */
  todayIso: string;
  timeoutMs?: number;
}

export async function fetchOpenCommitments(
  opts: FetchCommitmentsOptions
): Promise<CommitmentsResult> {
  const bin = opts.bin ?? 'hq-axi';
  try {
    const { stdout } = await execFileAsync(bin, ['commitment', 'list'], {
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { commitments: parseCommitments(stdout, opts.todayIso), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { commitments: [], error: `hq-axi commitment read failed: ${message}` };
  }
}

/** Parse `hq-axi commitment list` output, annotating overdue/due-today. */
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
