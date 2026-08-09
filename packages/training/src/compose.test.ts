import { describe, expect, it } from 'bun:test';
import { buildPlanPrompt, parseWeek } from './compose.js';
import type { PlanInputs } from './types.js';

const WEEK_START = '2026-08-10';

function inputs(overrides: Partial<PlanInputs> = {}): PlanInputs {
  return {
    weekStart: WEEK_START,
    weekEnd: '2026-08-16',
    activity: {
      windowDays: 42,
      totalCount: 3,
      bySport: [{ sport: 'run', count: 3, distanceMiles: 9.3, movingMinutes: 90 }],
      weekly: [{ weekStart: '2026-08-03', runMiles: 9.3, runCount: 3, crossCount: 0, crossMinutes: 0 }],
      longestRunMiles: 4.1,
      daysSinceLastRun: 2,
      error: null,
    },
    weather: {
      days: [
        { date: '2026-08-10', summary: 'Partly sunny', highF: 88, lowF: 71, precipProbability: 10 },
      ],
      error: null,
    },
    availability: {
      days: [
        {
          date: '2026-08-10',
          meetingCount: 4,
          busyMinutes: 210,
          firstMeetingHour: 9,
          lastMeetingEndHour: 16,
          allDayNotes: [],
        },
      ],
      error: null,
    },
    priorWeek: null,
    ...overrides,
  };
}

describe('buildPlanPrompt', () => {
  it('names every day of the plan week', () => {
    const prompt = buildPlanPrompt(inputs());
    expect(prompt).toContain('Mon 2026-08-10');
    expect(prompt).toContain('Sun 2026-08-16');
  });

  it('states an unavailable source as unavailable rather than omitting it', () => {
    // A section that silently vanishes reads to a model as "nothing to report",
    // which is the opposite of what a missing forecast means.
    const prompt = buildPlanPrompt(
      inputs({ weather: { days: [], error: 'forecast not configured' } })
    );
    expect(prompt).toContain('UNAVAILABLE: forecast not configured');
    expect(prompt).toContain('leave venue "either"');
  });

  it('distinguishes an empty history from an unavailable one', () => {
    const empty = buildPlanPrompt(
      inputs({
        activity: {
          windowDays: 42,
          totalCount: 0,
          bySport: [],
          weekly: [],
          longestRunMiles: 0,
          daysSinceLastRun: null,
          error: null,
        },
      })
    );
    expect(empty).toContain('No activities recorded in the window.');
    expect(empty).not.toContain('UNAVAILABLE');
  });

  it('carries instance goal context verbatim and never invents one', () => {
    const withGoal = buildPlanPrompt(inputs(), { goalContext: 'Build back to a 10 mile long run.' });
    expect(withGoal).toContain('Build back to a 10 mile long run.');

    const without = buildPlanPrompt(inputs());
    expect(without).toContain('No goal context configured');
  });

  it('includes the previous week so the model can name what changed', () => {
    const prompt = buildPlanPrompt(
      inputs({
        priorWeek: {
          weekStart: '2026-08-03',
          summary: 'Re-entry week',
          sessions: [
            {
              date: '2026-08-04',
              kind: 'run',
              title: 'Easy run 3 mi',
              detail: '',
              distanceMiles: 3,
              durationMinutes: null,
              why: '',
              venue: 'either',
            },
          ],
        },
      })
    );
    expect(prompt).toContain('Week of 2026-08-03: Re-entry week');
    expect(prompt).toContain('Easy run 3 mi');
  });
});

describe('parseWeek', () => {
  const good = JSON.stringify({
    summary: 'Consistency week',
    rationale: 'Three short runs, nothing long.',
    adjustments: ['Dropped the long run', ''],
    sessions: [
      {
        date: '2026-08-12',
        kind: 'run',
        title: 'Easy run 3 mi',
        detail: '9:30-10:00/mi',
        distanceMiles: 3,
        durationMinutes: 30,
        why: 'Only 4 mi logged last week',
        venue: 'outdoor',
      },
      {
        date: '2026-08-10',
        kind: 'rest',
        title: 'Rest',
        detail: '',
        distanceMiles: null,
        durationMinutes: null,
        why: 'Jammed calendar',
        venue: 'either',
      },
    ],
  });

  it('parses, sorts by date, and drops blank adjustments', () => {
    const week = parseWeek(good, WEEK_START);
    expect(week.summary).toBe('Consistency week');
    expect(week.adjustments).toEqual(['Dropped the long run']);
    expect(week.sessions.map((s) => s.date)).toEqual(['2026-08-10', '2026-08-12']);
    expect(week.sessions[0]!.kind).toBe('rest');
  });

  it('tolerates a stray code fence', () => {
    expect(parseWeek('```json\n' + good + '\n```', WEEK_START).sessions).toHaveLength(2);
  });

  it('rejects a date outside the plan week', () => {
    // A plan naming days it wasn't asked about is worse than no plan: it would
    // be stored against a week whose briefing never renders it.
    const raw = JSON.stringify({
      summary: 's',
      rationale: 'r',
      adjustments: [],
      sessions: [{ date: '2026-09-01', kind: 'run', title: 't' }],
    });
    expect(() => parseWeek(raw, WEEK_START)).toThrow(/outside the plan week/);
  });

  it('rejects a duplicated date', () => {
    const raw = JSON.stringify({
      summary: 's',
      rationale: 'r',
      adjustments: [],
      sessions: [
        { date: '2026-08-11', kind: 'run', title: 'a' },
        { date: '2026-08-11', kind: 'rest', title: 'b' },
      ],
    });
    expect(() => parseWeek(raw, WEEK_START)).toThrow(/more than once/);
  });

  it('rejects an unknown session kind', () => {
    const raw = JSON.stringify({
      summary: 's',
      rationale: 'r',
      adjustments: [],
      sessions: [{ date: '2026-08-11', kind: 'yoga-ish', title: 'a' }],
    });
    expect(() => parseWeek(raw, WEEK_START)).toThrow(/kind must be one of/);
  });

  it('coerces an unknown venue to "either" instead of failing the whole week', () => {
    const raw = JSON.stringify({
      summary: 's',
      rationale: 'r',
      adjustments: [],
      sessions: [{ date: '2026-08-11', kind: 'run', title: 'a', venue: 'the moon' }],
    });
    expect(parseWeek(raw, WEEK_START).sessions[0]!.venue).toBe('either');
  });

  it('nulls a negative or non-numeric distance rather than storing it', () => {
    const raw = JSON.stringify({
      summary: 's',
      rationale: 'r',
      adjustments: [],
      sessions: [
        { date: '2026-08-11', kind: 'run', title: 'a', distanceMiles: -3, durationMinutes: 'ten' },
      ],
    });
    const session = parseWeek(raw, WEEK_START).sessions[0]!;
    expect(session.distanceMiles).toBeNull();
    expect(session.durationMinutes).toBeNull();
  });

  it('rejects an empty session list', () => {
    const raw = JSON.stringify({ summary: 's', rationale: 'r', adjustments: [], sessions: [] });
    expect(() => parseWeek(raw, WEEK_START)).toThrow(/must not be empty/);
  });
});
