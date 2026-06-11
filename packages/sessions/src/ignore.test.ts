import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_SESSION_IGNORE_MARKERS,
  matchesIgnoreMarker,
} from './ignore.js';

describe('matchesIgnoreMarker', () => {
  const M87 = 'You are triaging a local-first M87 review item.';

  it('matches when a user message is the M87 triage prompt (default markers)', () => {
    const userMessages = [
      '<command-name>/model</command-name>',
      `${M87}\n\nUse the provided prompt context to produce a recommendation.`,
    ];
    expect(matchesIgnoreMarker(userMessages)).toBe(true);
  });

  it('ships the M87 marker in the defaults', () => {
    expect(DEFAULT_SESSION_IGNORE_MARKERS).toContain(M87);
  });

  it('does not match ordinary session user messages', () => {
    const userMessages = [
      'please refactor the scanner and run the tests',
      'now commit it',
    ];
    expect(matchesIgnoreMarker(userMessages)).toBe(false);
  });

  it('matches any of multiple custom markers', () => {
    const markers = ['ALPHA-MARKER', 'BETA-MARKER'];
    expect(matchesIgnoreMarker(['...BETA-MARKER...'], markers)).toBe(true);
    expect(matchesIgnoreMarker(['...GAMMA...'], markers)).toBe(false);
  });

  it('never matches when the marker list is empty', () => {
    expect(matchesIgnoreMarker([M87], [])).toBe(false);
  });

  it('never matches when there are no user messages', () => {
    expect(matchesIgnoreMarker([])).toBe(false);
  });

  it('ignores empty-string markers', () => {
    expect(matchesIgnoreMarker(['anything'], [''])).toBe(false);
  });
});
