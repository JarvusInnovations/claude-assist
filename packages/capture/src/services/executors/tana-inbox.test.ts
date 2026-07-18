import { describe, expect, it } from 'bun:test';
import { formatTanaPaste } from './tana-inbox.js';
import type { CaptureRecord } from '../../types.js';

function makeCapture(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    source: 'terminal',
    text: 'a stray thought',
    type_hint: null,
    urls: [],
    tags: [],
    payload: {},
    captured_at: new Date('2026-07-10T12:00:00Z'),
    received_at: new Date('2026-07-10T12:00:01Z'),
    status: 'classified',
    classification: null,
    classified_at: null,
    classify_attempts: 0,
    route_destination: 'tana-inbox',
    route_attempts: 0,
    routed_at: null,
    route_result: null,
    last_error: null,
    last_error_at: null,
  resolution: null,
  resolved_at: null,
    ...overrides,
  };
}

describe('formatTanaPaste', () => {
  it('renders a single-line thought with provenance child', () => {
    const paste = formatTanaPaste(makeCapture());
    const lines = paste.split('\n');
    expect(lines[0]).toBe('- a stray thought');
    expect(lines[1]).toBe(
      '  - captured:: 2026-07-10T12:00:00.000Z via terminal (01ARZ3NDEKTSV4RRFFQ69G5FAV)'
    );
  });

  it('turns extra text lines into children', () => {
    const paste = formatTanaPaste(makeCapture({ text: 'first line\nsecond line\n\nthird' }));
    expect(paste).toContain('- first line\n  - second line\n  - third');
  });

  it('appends URLs not already present in the text', () => {
    const paste = formatTanaPaste(
      makeCapture({ text: 'thought with https://inline.example', urls: ['https://inline.example', 'https://extra.example'] })
    );
    expect(paste).toContain('  - https://extra.example');
    expect(paste).not.toContain('  - https://inline.example');
  });

  it('includes tags as a field child when present', () => {
    const paste = formatTanaPaste(makeCapture({ tags: ['reading', 'ai'] }));
    expect(paste).toContain('  - tags:: reading, ai');
  });
});
