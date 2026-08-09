import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_SESSION_IGNORE_MARKERS,
  matchesIgnoreMarker,
} from './ignore.js';

describe('matchesIgnoreMarker', () => {
  const RUNNER_PROMPT = 'You are triaging a review item.';

  it('matches a configured marker anywhere in a user message', () => {
    const userMessages = [
      '<command-name>/model</command-name>',
      `${RUNNER_PROMPT}\n\nUse the provided prompt context to produce a recommendation.`,
    ];
    expect(matchesIgnoreMarker(userMessages, [RUNNER_PROMPT])).toBe(true);
  });

  it('ships no default markers — which automation to suppress is instance data', () => {
    expect(DEFAULT_SESSION_IGNORE_MARKERS).toEqual([]);
    expect(matchesIgnoreMarker([RUNNER_PROMPT])).toBe(false);
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
    expect(matchesIgnoreMarker([RUNNER_PROMPT], [])).toBe(false);
  });

  it('never matches when there are no user messages', () => {
    expect(matchesIgnoreMarker([])).toBe(false);
  });

  it('ignores empty-string markers', () => {
    expect(matchesIgnoreMarker(['anything'], [''])).toBe(false);
  });
});
