import { describe, expect, it } from 'bun:test';
import { computeTimelineSegments, downsampleReadings, TIMELINE_GAP_MS } from './timeline.js';

describe('computeTimelineSegments', () => {
  it('returns no segments for an empty input', () => {
    expect(computeTimelineSegments([])).toEqual([]);
  });

  it('a single event is one segment with no preceding gap', () => {
    const t = new Date('2026-01-01T00:00:00Z');
    expect(computeTimelineSegments([t])).toEqual([{ start: t.toISOString(), end: t.toISOString(), gapBeforeMs: null }]);
  });

  it('a continuous run under the gap threshold is one segment', () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    const timestamps = [0, 5 * 60_000, 10 * 60_000, 29 * 60_000].map((ms) => new Date(base + ms));
    const segments = computeTimelineSegments(timestamps);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.start).toBe(timestamps[0]!.toISOString());
    expect(segments[0]!.end).toBe(timestamps[3]!.toISOString());
    expect(segments[0]!.gapBeforeMs).toBeNull();
  });

  it('a gap over 30 minutes splits into two segments with the gap duration recorded', () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    const a = new Date(base);
    const b = new Date(base + 5 * 60_000);
    const gapMs = 9 * 60 * 60_000; // 9 hours
    const c = new Date(b.getTime() + gapMs);
    const d = new Date(c.getTime() + 60_000);

    const segments = computeTimelineSegments([a, b, c, d]);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ start: a.toISOString(), end: b.toISOString(), gapBeforeMs: null });
    expect(segments[1]).toEqual({ start: c.toISOString(), end: d.toISOString(), gapBeforeMs: gapMs });
  });

  it('a gap of exactly 30 minutes does not split (strictly greater-than)', () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    const a = new Date(base);
    const b = new Date(base + TIMELINE_GAP_MS);
    expect(computeTimelineSegments([a, b])).toHaveLength(1);
  });

  it('multiple gaps produce multiple segments, each with its own gap duration', () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    const a = new Date(base);
    const b = new Date(base + 2 * 24 * 60 * 60_000); // +2 days
    const c = new Date(b.getTime() + 3 * 24 * 60 * 60_000); // +3 days more

    const segments = computeTimelineSegments([a, b, c]);
    expect(segments).toHaveLength(3);
    expect(segments[0]!.gapBeforeMs).toBeNull();
    expect(segments[1]!.gapBeforeMs).toBe(2 * 24 * 60 * 60_000);
    expect(segments[2]!.gapBeforeMs).toBe(3 * 24 * 60 * 60_000);
  });

  it('handles out-of-order input by sorting first', () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    const a = new Date(base);
    const b = new Date(base + 60_000);
    const segments = computeTimelineSegments([b, a]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.start).toBe(a.toISOString());
    expect(segments[0]!.end).toBe(b.toISOString());
  });
});

describe('downsampleReadings', () => {
  function reading(tokens: number, i: number) {
    return { ts: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000), tokens };
  }

  it('is a no-op when already at or under the ceiling', () => {
    const readings = Array.from({ length: 600 }, (_, i) => reading(i, i));
    expect(downsampleReadings(readings, 600)).toEqual(readings);
    const small = Array.from({ length: 3 }, (_, i) => reading(i, i));
    expect(downsampleReadings(small, 600)).toEqual(small);
  });

  it('caps the output at (approximately) the requested ceiling', () => {
    const readings = Array.from({ length: 50_000 }, (_, i) => reading(i % 1000, i));
    const out = downsampleReadings(readings, 600);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.length).toBeGreaterThan(0);
  });

  it('keeps the global peak reading', () => {
    const readings = Array.from({ length: 10_000 }, (_, i) => reading(i, i));
    readings[7777] = reading(999_999, 7777); // the global peak, buried mid-stream
    const out = downsampleReadings(readings, 600);
    expect(out.some((r) => r.tokens === 999_999)).toBe(true);
  });

  it('keeps each bucket last so a post-compaction drop is visible at the boundary', () => {
    // A bucket whose max comes first and whose last value is much smaller
    // (simulating a compaction mid-bucket) must report BOTH.
    const readings = [reading(100_000, 0), reading(50_000, 1), reading(20_000, 2), reading(500, 3)];
    const out = downsampleReadings(readings, 2); // force everything into 1 bucket (maxPoints/2 = 1)
    expect(out).toEqual([reading(100_000, 0), reading(500, 3)]);
  });

  it('a bucket whose max IS its last contributes exactly one point', () => {
    const readings = [reading(10, 0), reading(20, 1), reading(30, 2)];
    const out = downsampleReadings(readings, 2);
    expect(out).toEqual([reading(30, 2)]);
  });

  it('preserves ascending order of the surviving points', () => {
    const readings = Array.from({ length: 5000 }, (_, i) => reading(Math.sin(i) * 1000 + i, i));
    const out = downsampleReadings(readings, 600);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.ts.getTime()).toBeGreaterThanOrEqual(out[i - 1]!.ts.getTime());
    }
  });
});
