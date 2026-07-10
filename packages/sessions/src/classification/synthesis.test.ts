import { describe, expect, it } from 'bun:test';
import {
  buildSynthesisPrompt,
  buildNarrativePrompt,
  renderEventCorpus,
  lastWeekPeriod,
} from './synthesis.js';
import type { ActiveSessionSummary, ClassificationEventWithContext } from './types.js';

function event(
  over: Partial<ClassificationEventWithContext> = {}
): ClassificationEventWithContext {
  return {
    id: '1',
    session_id: 's1',
    seq_start: 0,
    seq_end: 5,
    event_type: 'correction',
    summary: 'Chris corrected the deploy target',
    confidence: 0.9,
    quote: 'no, deploy to devbox not prod',
    model: 'claude-haiku-4-5',
    created_at: new Date('2026-07-05T12:00:00Z'),
    project_path: '/home/chris/claude-assist',
    git_branch: 'main',
    title: 'deploy work',
    ...over,
  };
}

const FIXTURE: ClassificationEventWithContext[] = [
  event(),
  event({ id: '2', event_type: 'friction', summary: 'tofu apply blocked on lock', confidence: 0.7, quote: 'still locked' }),
  event({ id: '3', event_type: 'friction', summary: 'permission prompt loop', confidence: 0.6, quote: null }),
  event({ id: '4', event_type: 'rule-candidate', summary: 'always use -concise on tofu', confidence: 0.95, quote: 'always add -concise' }),
  event({ id: '5', event_type: 'notable-decision', summary: 'chose per-session cursors', confidence: 0.8, quote: null, project_path: '/home/chris/Hari' }),
];

describe('lastWeekPeriod', () => {
  it('spans exactly 7 days ending at the given instant', () => {
    const p = lastWeekPeriod(new Date('2026-07-10T00:00:00Z'));
    expect(p.endLabel).toBe('2026-07-10');
    expect(p.startLabel).toBe('2026-07-03');
    expect(p.end.getTime() - p.start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('renderEventCorpus', () => {
  it('groups by type in priority order with counts, project labels, and quotes', () => {
    const rendered = renderEventCorpus(FIXTURE);
    // Section order: correction, friction, rule-candidate, notable-decision.
    const idxCorr = rendered.indexOf('## correction');
    const idxFric = rendered.indexOf('## friction (2)');
    const idxRule = rendered.indexOf('## rule-candidate');
    const idxDec = rendered.indexOf('## notable-decision');
    expect(idxCorr).toBeGreaterThanOrEqual(0);
    expect(idxCorr).toBeLessThan(idxFric);
    expect(idxFric).toBeLessThan(idxRule);
    expect(idxRule).toBeLessThan(idxDec);
    // Project basename label + verbatim quote surface.
    expect(rendered).toContain('[claude-assist]');
    expect(rendered).toContain('no, deploy to devbox not prod');
  });

  it('handles an empty corpus', () => {
    expect(renderEventCorpus([])).toContain('no classification events');
  });
});

describe('buildSynthesisPrompt', () => {
  it('carries the period, event count, and grouped corpus', () => {
    const p = lastWeekPeriod(new Date('2026-07-10T00:00:00Z'));
    const prompt = buildSynthesisPrompt(p, FIXTURE);
    expect(prompt).toContain('<period>2026-07-03 to 2026-07-10</period>');
    expect(prompt).toContain('<event_count>5</event_count>');
    expect(prompt).toContain('## correction');
    expect(prompt).toContain('always use -concise on tofu');
  });
});

describe('buildNarrativePrompt', () => {
  const active: ActiveSessionSummary[] = [
    {
      id: 's1',
      project_path: '/home/chris/claude-assist',
      title: 'deploy work',
      session_name: null,
      started_at: new Date('2026-07-05T10:00:00Z'),
      ended_at: new Date('2026-07-05T13:00:00Z'),
      event_count: 4,
    },
  ];

  it('lists active sessions with signal counts and includes the corpus', () => {
    const p = lastWeekPeriod(new Date('2026-07-10T00:00:00Z'));
    const prompt = buildNarrativePrompt(p, FIXTURE, active);
    expect(prompt).toContain('<active_sessions>');
    expect(prompt).toContain('[claude-assist] deploy work (4 signals)');
    expect(prompt).toContain('## friction (2)');
  });

  it('degrades gracefully with no active sessions', () => {
    const p = lastWeekPeriod(new Date('2026-07-10T00:00:00Z'));
    const prompt = buildNarrativePrompt(p, [], []);
    expect(prompt).toContain('no active sessions with signals');
  });
});
