/**
 * Prompt assembly and answer validation for the weekly synthesis.
 *
 * Pure, and the only place the module's judgment about *what a good week looks
 * like* is written down. Two rules shape it:
 *
 *  1. **The inputs are named as inputs, including their absence.** An
 *     unavailable forecast is stated as unavailable, never omitted — a section
 *     that silently vanishes reads to a model as "nothing to report".
 *  2. **The goal is instance data.** `goalContext` is free text supplied by
 *     configuration (a race, a maintenance block, a return-from-injury ramp).
 *     Nothing about any particular athlete, race, or plan is committed here.
 */

import type { PlanInputs, PlannedSession, SessionKind, SessionVenue, SynthesizedWeek } from './types.js';
import { weekDates, weekdayName } from './week.js';

export const SESSION_KINDS: SessionKind[] = ['run', 'cross', 'strength', 'mobility', 'rest', 'race'];
export const SESSION_VENUES: SessionVenue[] = ['indoor', 'outdoor', 'either'];

export const PLAN_TAG = 'week';

export const SYSTEM_PROMPT = `<role>
You are a training planner. You lay out ONE calendar week of training for a single athlete, adapting to what they actually did recently rather than to what an idealized plan said they would do.
</role>

<method>
- Start from the evidence. The activity history is the ground truth about current fitness and consistency; the previous week's plan is context, not a commitment. Where they disagree, the history wins.
- Adapt the load to what the body has absorbed. Sharp jumps in impact volume are the injury axis: prefer consistency over volume, and volume over intensity, when recent weeks are thin.
- Respect the calendar. Do not put the longest or hardest session on the most fragmented day. Early first meetings mean an early session must be short or moved.
- Respect the forecast. Push a session indoors, or move it within the week, when the weather is genuinely hostile; do not move things for ordinary conditions.
- Cross-training is not filler. When impact tolerance is the constraint, hard efforts belong on low-impact modalities.
- Every day of the week gets an entry, including rest days. A rest day is a decision, and saying so out loud is what stops it from being an accident.
- Name what CHANGED versus the previous week and why. That list is what a human is being asked to approve.
</method>

<response_format>
Return ONLY a <week>…</week> block containing a single JSON object:

<week>
{
  "summary": "one line, under 90 characters, naming the week's job",
  "rationale": "2-4 sentences grounding the week in the inputs",
  "adjustments": ["what changed vs. the previous week, one short line each"],
  "sessions": [
    {
      "date": "YYYY-MM-DD",
      "kind": "run|cross|strength|mobility|rest|race",
      "title": "short imperative title",
      "detail": "structure, pace or effort, in one line",
      "distanceMiles": 4.0,
      "durationMinutes": 40,
      "why": "one line tying this session to the inputs",
      "venue": "indoor|outdoor|either"
    }
  ]
}
</week>

Exactly one session object per date in the plan week, in date order. Use null for distanceMiles or durationMinutes when the session isn't shaped that way. No prose outside the tags, no markdown fences.
</response_format>`;

export interface PromptOptions {
  /** Free-text instance config: the goal, the block, the constraints. */
  goalContext?: string;
}

export function buildPlanPrompt(inputs: PlanInputs, opts: PromptOptions = {}): string {
  const lines: string[] = [];

  lines.push(`<plan_week start="${inputs.weekStart}" end="${inputs.weekEnd}">`);
  for (const date of weekDates(inputs.weekStart)) {
    lines.push(`  ${weekdayName(date)} ${date}`);
  }
  lines.push('</plan_week>');
  lines.push('');

  lines.push('<goal_context>');
  lines.push(
    opts.goalContext?.trim()
      ? opts.goalContext.trim()
      : 'No goal context configured. Plan a balanced maintenance week consistent with the recent activity history.'
  );
  lines.push('</goal_context>');
  lines.push('');

  lines.push(`<activity_history window_days="${inputs.activity.windowDays}">`);
  if (inputs.activity.error) {
    lines.push(`  UNAVAILABLE: ${inputs.activity.error}`);
    lines.push('  Plan conservatively — recent load is unknown.');
  } else if (inputs.activity.totalCount === 0) {
    lines.push('  No activities recorded in the window.');
  } else {
    lines.push(`  ${inputs.activity.totalCount} activities.`);
    lines.push(`  Longest run: ${inputs.activity.longestRunMiles} mi.`);
    lines.push(
      `  Days since last run: ${
        inputs.activity.daysSinceLastRun === null ? 'no run in window' : inputs.activity.daysSinceLastRun
      }.`
    );
    lines.push('  By sport:');
    for (const s of inputs.activity.bySport) {
      lines.push(`    ${s.sport}: ${s.count} sessions, ${s.distanceMiles} mi, ${s.movingMinutes} min`);
    }
    lines.push('  By week (most recent first):');
    for (const w of inputs.activity.weekly) {
      lines.push(
        `    ${w.weekStart}: ${w.runCount} runs / ${w.runMiles} mi; ` +
          `${w.crossCount} cross / ${w.crossMinutes} min`
      );
    }
  }
  lines.push('</activity_history>');
  lines.push('');

  lines.push('<forecast>');
  if (inputs.weather.error) {
    lines.push(`  UNAVAILABLE: ${inputs.weather.error}`);
    lines.push('  Do not assume conditions; leave venue "either" unless another input forces a choice.');
  } else if (inputs.weather.days.length === 0) {
    lines.push('  No forecast covers this week yet.');
  } else {
    for (const d of inputs.weather.days) {
      const hi = d.highF === null ? '?' : `${d.highF}F`;
      const lo = d.lowF === null ? '?' : `${d.lowF}F`;
      const pop = d.precipProbability === null ? '?' : `${d.precipProbability}%`;
      lines.push(`  ${weekdayName(d.date)} ${d.date}: ${d.summary || 'no phrase'}, ${lo}–${hi}, precip ${pop}`);
    }
  }
  lines.push('</forecast>');
  lines.push('');

  lines.push('<calendar_availability>');
  if (inputs.availability.error) {
    lines.push(`  UNAVAILABLE: ${inputs.availability.error}`);
    lines.push('  Assume ordinary weekdays; keep weekday sessions modest and flexible.');
  } else {
    for (const d of inputs.availability.days) {
      const first = d.firstMeetingHour === null ? '—' : `${pad2(d.firstMeetingHour)}:00`;
      const last = d.lastMeetingEndHour === null ? '—' : `${pad2(d.lastMeetingEndHour)}:00`;
      const notes = d.allDayNotes.length > 0 ? ` | all-day: ${d.allDayNotes.join('; ')}` : '';
      lines.push(
        `  ${weekdayName(d.date)} ${d.date}: ${d.meetingCount} meetings, ` +
          `${d.busyMinutes} busy min, first ${first}, last ends ${last}${notes}`
      );
    }
  }
  lines.push('</calendar_availability>');
  lines.push('');

  lines.push('<previous_week>');
  if (!inputs.priorWeek) {
    lines.push('  None — this is the first planned week. Nothing to diff against; leave "adjustments" empty.');
  } else {
    lines.push(`  Week of ${inputs.priorWeek.weekStart}: ${inputs.priorWeek.summary}`);
    for (const s of inputs.priorWeek.sessions) {
      lines.push(`    ${weekdayName(s.date)} ${s.date} — ${s.kind}: ${s.title}`);
    }
  }
  lines.push('</previous_week>');

  return lines.join('\n');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Validate the model's answer against the week it was asked to plan.
 *
 * Throws on anything structurally wrong — which is the contract `invokeTagged`
 * wants: a throw buys exactly one correction turn, and a plan that names days
 * outside its own week is worse than no plan at all.
 *
 * Exported for tests.
 */
export function parseWeek(raw: string, weekStart: string): SynthesizedWeek {
  const parsed: unknown = JSON.parse(stripFences(raw));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected a JSON object');
  }
  const obj = parsed as Record<string, unknown>;

  const summary = requireString(obj.summary, 'summary');
  const rationale = requireString(obj.rationale, 'rationale');
  const adjustments = Array.isArray(obj.adjustments)
    ? obj.adjustments.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
    : [];

  if (!Array.isArray(obj.sessions)) throw new Error('sessions must be an array');
  const valid = new Set(weekDates(weekStart));
  const seen = new Set<string>();
  const sessions: PlannedSession[] = obj.sessions.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`sessions[${i}] must be an object`);
    const s = entry as Record<string, unknown>;
    const date = requireString(s.date, `sessions[${i}].date`);
    if (!valid.has(date)) {
      throw new Error(`sessions[${i}].date ${date} is outside the plan week starting ${weekStart}`);
    }
    if (seen.has(date)) throw new Error(`sessions[${i}].date ${date} appears more than once`);
    seen.add(date);

    const kind = requireString(s.kind, `sessions[${i}].kind`).toLowerCase();
    if (!(SESSION_KINDS as string[]).includes(kind)) {
      throw new Error(`sessions[${i}].kind must be one of ${SESSION_KINDS.join('|')}`);
    }
    const venueRaw = typeof s.venue === 'string' ? s.venue.toLowerCase() : 'either';
    const venue = (SESSION_VENUES as string[]).includes(venueRaw) ? venueRaw : 'either';

    return {
      date,
      kind: kind as SessionKind,
      title: requireString(s.title, `sessions[${i}].title`),
      detail: typeof s.detail === 'string' ? s.detail : '',
      distanceMiles: numberOrNull(s.distanceMiles),
      durationMinutes: numberOrNull(s.durationMinutes),
      why: typeof s.why === 'string' ? s.why : '',
      venue: venue as SessionVenue,
    };
  });

  if (sessions.length === 0) throw new Error('sessions must not be empty');
  sessions.sort((a, b) => (a.date < b.date ? -1 : 1));

  return { summary, rationale, adjustments, sessions };
}

/** The model was told not to fence, but a stray ```json costs one whole retry. */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1]!.trim() : trimmed;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function numberOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 10) / 10;
}
