import { describe, expect, it } from 'bun:test';
import type { CalendarEvent } from '../types.js';
import { occurrenceIdentity } from './occurrence.js';
import { buildPrepPrompt, deterministicPrep, inputsDigest, type PrepInputs } from './compose.js';

function ev(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'abc_20260717',
    seriesId: 'abc',
    summary: 'Vendor sync',
    start: '2026-07-17T15:00:00-04:00',
    end: '2026-07-17T15:30:00-04:00',
    allDay: false,
    startMs: Date.parse('2026-07-17T15:00:00-04:00'),
    myResponse: 'accepted',
    attendeeCount: 4,
    location: 'Room 5',
    hangoutLink: '',
    description: 'Agenda: statuses',
    status: 'confirmed',
    ...over,
  };
}

function inputs(over: Partial<PrepInputs> = {}): PrepInputs {
  const target = ev();
  return {
    occurrence: occurrenceIdentity(target),
    targetEvent: target,
    history: [],
    priorContext: '',
    captures: [],
    contextError: null,
    capturesError: null,
    ...over,
  };
}

describe('inputsDigest', () => {
  it('is stable across calls for the same inputs', () => {
    expect(inputsDigest(inputs())).toBe(inputsDigest(inputs()));
  });

  it('changes when a capture is added (so a refresh recomposes)', () => {
    const before = inputsDigest(inputs());
    const after = inputsDigest(
      inputs({ captures: [{ ulid: '01J', text: 'raise the budget question', capturedAt: '2026-07-15T00:00:00Z', tags: [] }] })
    );
    expect(after).not.toBe(before);
  });

  it('changes when prior context changes', () => {
    expect(inputsDigest(inputs({ priorContext: 'last time we deferred X' }))).not.toBe(inputsDigest(inputs()));
  });

  it('is insensitive to capture ordering (keyed on the ulid set)', () => {
    const a = inputs({
      captures: [
        { ulid: '01A', text: 'one', capturedAt: 't', tags: [] },
        { ulid: '01B', text: 'two', capturedAt: 't', tags: [] },
      ],
    });
    const b = inputs({
      captures: [
        { ulid: '01B', text: 'two', capturedAt: 't', tags: [] },
        { ulid: '01A', text: 'one', capturedAt: 't', tags: [] },
      ],
    });
    expect(inputsDigest(a)).toBe(inputsDigest(b));
  });
});

describe('deterministicPrep', () => {
  it('assembles history, context, and captures as bullets', () => {
    const prep = deterministicPrep(
      inputs({
        history: [ev({ id: 'abc_20260710', start: '2026-07-10T15:00:00-04:00' })],
        priorContext: 'Agreed to send the quote.',
        captures: [{ ulid: '01J', text: 'ask about the invoice', capturedAt: 't', tags: [] }],
      })
    );
    expect(prep).toContain('prior occurrence');
    expect(prep).toContain('Agreed to send the quote.');
    expect(prep).toContain('ask about the invoice');
    // Every line is a bullet (no supertags / numbered lists).
    for (const line of prep.split('\n')) expect(line.trimStart().startsWith('- ')).toBe(true);
  });

  it('surfaces a flagged source error rather than dropping the section', () => {
    const prep = deterministicPrep(inputs({ capturesError: 'schema missing' }));
    expect(prep).toContain('Not available: schema missing');
  });

  it('says "None" for empty sections', () => {
    const prep = deterministicPrep(inputs());
    expect(prep).toContain('First tracked occurrence');
    expect(prep).toMatch(/Captured since last time\n {2}- None/);
  });
});

describe('buildPrepPrompt', () => {
  it('frames the meeting, history, context, and captures as tagged sections', () => {
    const prompt = buildPrepPrompt(
      inputs({
        history: [ev({ id: 'abc_20260710' })],
        priorContext: 'notes here',
        captures: [{ ulid: '01J', text: 'thing to raise', capturedAt: 't', tags: [] }],
      })
    );
    expect(prompt).toContain('<meeting>');
    expect(prompt).toContain('<prior_occurrences>');
    expect(prompt).toContain('<prior_context>');
    expect(prompt).toContain('<captured_since_last_time>');
    expect(prompt).toContain('thing to raise');
  });
});
