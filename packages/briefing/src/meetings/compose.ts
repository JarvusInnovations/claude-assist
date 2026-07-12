/**
 * Prep composition — pure assembly of the prep's inputs into (a) a stable
 * inputs digest, (b) the model prompt, and (c) a deterministic fallback prep
 * when no model is wired. The side-effecting model call lives in model.ts; the
 * render lives in render.ts. All three are testable in isolation.
 *
 * Inputs (per plans/meeting-briefings.md): HQ/participant timelines +
 * prior-occurrence transcript/notes (pluggable context source), calendar
 * history (prior occurrences of the series), and captures routed to the series
 * (rolling agenda). The digest is what a refresh compares against to avoid a
 * redundant recompose when nothing changed.
 */

import { createHash } from 'node:crypto';
import type { CalendarEvent } from '../types.js';
import type { OccurrenceIdentity } from './types.js';
import type { MeetingCapture } from './captures-source.js';

export interface PrepInputs {
  occurrence: OccurrenceIdentity;
  /** The target occurrence's own event (attendees, location, description). */
  targetEvent: CalendarEvent;
  /** Prior occurrences of the series, oldest→newest (calendar history). */
  history: CalendarEvent[];
  /** Opaque prior-occurrence context (transcripts/notes/timelines) from the pluggable source. */
  priorContext: string;
  /** Captures routed to the series since the prior occurrence. */
  captures: MeetingCapture[];
  /** Flagged non-fatal source errors, surfaced in the prep so gaps are visible. */
  contextError?: string | null;
  capturesError?: string | null;
}

/**
 * Stable content hash of the load-bearing inputs. Deliberately excludes
 * volatile fields (fetch timestamps) so an unchanged agenda hashes identically
 * across passes. Capture identity is its ulid set; history is the occurrence
 * ids; context is its text.
 */
export function inputsDigest(inputs: PrepInputs): string {
  const shape = {
    occ: inputs.occurrence.occurrenceKey,
    start: inputs.occurrence.occurrenceStart,
    summary: inputs.targetEvent.summary,
    attendees: inputs.targetEvent.attendeeCount,
    location: inputs.targetEvent.location,
    description: inputs.targetEvent.description,
    history: inputs.history.map((e) => e.id).sort(),
    context: inputs.priorContext,
    captures: inputs.captures.map((c) => c.ulid).sort(),
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

function whenLabel(e: CalendarEvent): string {
  const s = e.start;
  return s.includes('T') ? s.slice(0, 16).replace('T', ' ') : s;
}

/** The model prompt body: everything the composer needs, framed as sections. */
export function buildPrepPrompt(inputs: PrepInputs): string {
  const parts: string[] = [];
  parts.push(`<meeting>`);
  parts.push(`<summary>${inputs.targetEvent.summary || '(untitled)'}</summary>`);
  parts.push(`<when>${inputs.occurrence.occurrenceStart}</when>`);
  parts.push(`<attendee_count>${inputs.targetEvent.attendeeCount}</attendee_count>`);
  if (inputs.targetEvent.location) parts.push(`<location>${inputs.targetEvent.location}</location>`);
  if (inputs.targetEvent.description) {
    parts.push(`<description>${inputs.targetEvent.description.slice(0, 1500)}</description>`);
  }
  parts.push(`</meeting>`);

  if (inputs.history.length > 0) {
    parts.push(`<prior_occurrences>`);
    for (const e of inputs.history.slice(-6)) parts.push(`- ${whenLabel(e)}: ${e.summary || '(untitled)'}`);
    parts.push(`</prior_occurrences>`);
  }

  if (inputs.priorContext.trim()) {
    parts.push(`<prior_context>\n${inputs.priorContext.slice(0, 6000)}\n</prior_context>`);
  }

  if (inputs.captures.length > 0) {
    parts.push(`<captured_since_last_time>`);
    for (const c of inputs.captures) parts.push(`- ${collapse(c.text).slice(0, 300)}`);
    parts.push(`</captured_since_last_time>`);
  }

  return parts.join('\n');
}

/**
 * Deterministic prep used when no model is wired (no Anthropic key) or the
 * model call fails — a plain, honest assembly of the raw inputs as a Tana-style
 * bullet outline. Never throws; degraded sources render as flagged lines.
 */
export function deterministicPrep(inputs: PrepInputs): string {
  const lines: string[] = [];
  lines.push('- Context');
  if (inputs.history.length > 0) {
    lines.push(`  - Recurring meeting — ${inputs.history.length} prior occurrence(s) on the calendar`);
    const last = inputs.history[inputs.history.length - 1]!;
    lines.push(`    - Last time: ${whenLabel(last)}`);
  } else {
    lines.push('  - First tracked occurrence of this meeting');
  }
  lines.push(`  - Attendees: ${inputs.targetEvent.attendeeCount}`);
  if (inputs.targetEvent.location) lines.push(`  - Location: ${inputs.targetEvent.location}`);

  lines.push('- Prior notes / transcript');
  if (inputs.contextError) lines.push(`  - Not available: ${inputs.contextError}`);
  else if (inputs.priorContext.trim()) {
    for (const ln of inputs.priorContext.split('\n').slice(0, 12)) {
      if (ln.trim()) lines.push(`  - ${collapse(ln).slice(0, 300)}`);
    }
  } else lines.push('  - None');

  lines.push('- Captured since last time');
  if (inputs.capturesError) lines.push(`  - Not available: ${inputs.capturesError}`);
  else if (inputs.captures.length > 0) {
    for (const c of inputs.captures) lines.push(`  - ${collapse(c.text).slice(0, 300)}`);
  } else lines.push('  - None');

  return lines.join('\n');
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
