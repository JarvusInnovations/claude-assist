/**
 * Prior-occurrence context source for meeting preps — pluggable, like the
 * daily briefing's commitments source.
 *
 * The toolkit does not know where a meeting's history lives (HQ timelines,
 * transcript stores, notes). It only knows the OUTPUT CONTRACT: the owner wires
 * a private CLI via `MEETING_CONTEXT_BIN` (+ optional `_ARGS`); the toolkit
 * shells out to it (read-only), passing the occurrence metadata as a single
 * JSON object on stdin, and treats whatever it prints on stdout as opaque
 * context text to fold into the prep.
 *
 * CONTRACT (documented for the owner):
 *   stdin  : JSON — { seriesKey, occurrenceKey, occurrenceStart, summary,
 *                     priorOccurrenceStart, attendees? }
 *   argv   : the configured args, then `--occurrence-key <key>`
 *            `--series-key <key>` (so arg-only CLIs work too)
 *   stdout : free-text context (markdown/plain). Empty output = no context.
 *   exit≠0 : treated as "unavailable" (flagged, non-fatal) — the prep still
 *            composes from calendar history + captures.
 *
 * Absence is first-class: no bin configured → no context section, no error.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface MeetingContextRequest {
  seriesKey: string;
  occurrenceKey: string;
  occurrenceStart: string | null;
  summary: string;
  /** Start of the prior occurrence, when known (lets the source scope "since last time"). */
  priorOccurrenceStart?: string | null;
  attendees?: string[];
}

export interface MeetingContextResult {
  /** Opaque context text, or '' when unavailable / not configured. */
  context: string;
  error: string | null;
}

export interface FetchMeetingContextOptions {
  /** Path to the context CLI. Unset → skipped cleanly (no error). */
  bin?: string;
  /** Args passed before the derived --series-key/--occurrence-key flags. */
  args?: string[];
  request: MeetingContextRequest;
  timeoutMs?: number;
}

export async function fetchMeetingContext(
  opts: FetchMeetingContextOptions
): Promise<MeetingContextResult> {
  const { bin } = opts;
  if (!bin) return { context: '', error: null };

  const args = [
    ...(opts.args ?? []),
    '--series-key',
    opts.request.seriesKey,
    '--occurrence-key',
    opts.request.occurrenceKey,
  ];

  try {
    const child = execFileAsync(bin, args, {
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    // Feed the occurrence metadata as JSON on stdin.
    child.child.stdin?.end(JSON.stringify(opts.request));
    const { stdout } = await child;
    return { context: stdout.trim(), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { context: '', error: `meeting context source failed: ${message}` };
  }
}
