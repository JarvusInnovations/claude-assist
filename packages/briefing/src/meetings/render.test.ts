import { describe, expect, it } from 'bun:test';
import type { MeetingPrep } from './types.js';
import {
  findChildIdByHeading,
  prepDateIso,
  prepHeading,
  renderPrepPaste,
} from './render.js';

function prep(over: Partial<MeetingPrep> = {}): MeetingPrep {
  return {
    occurrenceKey: 'abc_20260717',
    seriesKey: 'abc',
    occurrenceStart: '2026-07-17T15:00:00-04:00',
    summary: 'Vendor sync',
    status: 'draft',
    prepContent: '- Since last time\n  - Sent the quote\n- To raise\n  - Invoice timing',
    inputsDigest: 'd1',
    model: 'claude-sonnet-5',
    deliveredNodeId: null,
    generatedAt: null,
    refreshedAt: null,
    deliveredAt: null,
    ...over,
  };
}

describe('prepHeading + prepDateIso', () => {
  it('names the occurrence with summary + start', () => {
    expect(prepHeading(prep())).toBe('Meeting Prep — Vendor sync — 2026-07-17 15:00');
  });
  it('resolves the day node date from the occurrence start', () => {
    expect(prepDateIso(prep())).toBe('2026-07-17');
  });
});

describe('renderPrepPaste', () => {
  it('opens with the heading node and nests the prep body one level under it', () => {
    const paste = renderPrepPaste(prep());
    const lines = paste.split('\n');
    expect(lines[0]).toBe('- Meeting Prep — Vendor sync — 2026-07-17 15:00');
    expect(paste).toContain('  - Since last time');
    expect(paste).toContain('    - Sent the quote');
  });

  it('adds a link-out line when a page base url is configured', () => {
    const paste = renderPrepPaste(prep(), 'https://assist.example');
    expect(paste).toContain('Full prep: https://assist.example/meetings/abc_20260717');
  });

  it('uses only bullets (no supertags)', () => {
    for (const line of renderPrepPaste(prep()).split('\n')) {
      expect(line.trimStart().startsWith('- ')).toBe(true);
      expect(line).not.toContain('#');
    }
  });

  it('handles empty content', () => {
    expect(renderPrepPaste(prep({ prepContent: null }))).toContain('(no prep content)');
  });
});

describe('findChildIdByHeading', () => {
  const heading = prepHeading(prep());

  it('finds a child id when children are an array of {id,name}', () => {
    const text = JSON.stringify([
      { id: 'n1', name: 'Morning Briefing — 2026-07-17' },
      { id: 'n2', name: heading },
    ]);
    expect(findChildIdByHeading(text, heading)).toBe('n2');
  });

  it('finds a child id under a wrapper key with {nodeId,text}', () => {
    const text = JSON.stringify({ children: [{ nodeId: 'x9', text: `${heading} (edited)` }] });
    expect(findChildIdByHeading(text, heading)).toBe('x9');
  });

  it('returns null when no child matches', () => {
    expect(findChildIdByHeading(JSON.stringify([{ id: 'n1', name: 'unrelated' }]), heading)).toBeNull();
  });

  it('returns null on unparseable input', () => {
    expect(findChildIdByHeading('not json', heading)).toBeNull();
  });
});
