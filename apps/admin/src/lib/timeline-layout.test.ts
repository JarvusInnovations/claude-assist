import { describe, expect, it } from 'bun:test';
import {
  buildTimelineLayout,
  timeToX,
  isGapBlock,
  isSegmentBlock,
  dayBoundaryIndices,
  placeLabels,
  gapWeightMs,
  gapShade,
  calendarX,
  calendarTicks,
} from './timeline-layout';

describe('buildTimelineLayout', () => {
  it('returns nothing for no segments or a zero-width plot', () => {
    expect(buildTimelineLayout([], 1000)).toEqual([]);
    expect(buildTimelineLayout([{ start: 0, end: 1000, gapBeforeMs: null }], 0)).toEqual([]);
  });

  it('a single segment fills the whole plot width with no gap blocks', () => {
    const blocks = buildTimelineLayout([{ start: 0, end: 60_000, gapBeforeMs: null }], 1000);
    expect(blocks).toHaveLength(1);
    expect(blocks.filter(isGapBlock)).toHaveLength(0);
    const seg = blocks[0]!;
    expect(seg.x0).toBe(0);
    expect(seg.x1).toBeCloseTo(1000, 5);
  });

  it('inserts exactly one gap block between two segments', () => {
    const blocks = buildTimelineLayout(
      [
        { start: 0, end: 60_000, gapBeforeMs: null },
        { start: 3_600_000, end: 3_660_000, gapBeforeMs: 3_540_000 },
      ],
      1000
    );
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.kind)).toEqual(['segment', 'gap', 'segment']);
    const gap = blocks.find(isGapBlock)!;
    expect(gap.durationMs).toBe(3_540_000);
    // Blocks are contiguous, left to right, covering the full plot width.
    expect(blocks[0]!.x0).toBe(0);
    expect(blocks[2]!.x1).toBeCloseTo(1000, 5);
    expect(blocks[0]!.x1).toBeCloseTo(blocks[1]!.x0, 5);
    expect(blocks[1]!.x1).toBeCloseTo(blocks[2]!.x0, 5);
  });

  it('a longer gap gets a wider break, growing logarithmically rather than proportionally', () => {
    const H = 3_600_000;
    const blocks = buildTimelineLayout(
      [
        { start: 0, end: 60_000, gapBeforeMs: null },
        { start: 1 * H, end: 1 * H + 60_000, gapBeforeMs: 1 * H },
        { start: 600 * H, end: 600 * H + 60_000, gapBeforeMs: 504 * H },
      ],
      1000
    );
    const [hourGap, threeWeekGap] = blocks.filter(isGapBlock).map((g) => g.x1 - g.x0);
    expect(threeWeekGap!).toBeGreaterThan(hourGap! * 2);
    // Three weeks is ~500x an hour, but the break is nowhere near 500x wider.
    expect(threeWeekGap!).toBeLessThan(hourGap! * 10);
  });

  it('gapWeightMs is monotonic and floors at the 30-minute collapse threshold', () => {
    const M = 60_000;
    expect(gapWeightMs(10 * M)).toBe(gapWeightMs(30 * M));
    expect(gapWeightMs(2 * 60 * M)).toBeGreaterThan(gapWeightMs(60 * M));
    expect(gapWeightMs(7 * 24 * 60 * M)).toBeGreaterThan(gapWeightMs(24 * 60 * M));
  });

  it('a very short segment is floored to a minimum visible width, not squeezed to zero', () => {
    const blocks = buildTimelineLayout(
      [
        { start: 0, end: 1, gapBeforeMs: null }, // 1ms — would be invisible unfloored
        { start: 3_600_000, end: 3_600_060_000, gapBeforeMs: 3_600_000 },
      ],
      1000
    );
    const shortSeg = blocks.find(isSegmentBlock)!;
    expect(shortSeg.x1 - shortSeg.x0).toBeGreaterThan(0);
  });
});

describe('timeToX', () => {
  it('maps the start and end of a single segment to the plot edges', () => {
    const blocks = buildTimelineLayout([{ start: 1000, end: 2000, gapBeforeMs: null }], 1000);
    expect(timeToX(blocks, 1000)).toBeCloseTo(0, 5);
    expect(timeToX(blocks, 2000)).toBeCloseTo(1000, 5);
  });

  it('interpolates linearly within a segment', () => {
    const blocks = buildTimelineLayout([{ start: 0, end: 1000, gapBeforeMs: null }], 1000);
    expect(timeToX(blocks, 500)).toBeCloseTo(500, 5);
  });

  it('a timestamp inside the collapsed gap never lands there — callers only ask for real event timestamps, which always fall inside a segment', () => {
    const blocks = buildTimelineLayout(
      [
        { start: 0, end: 1000, gapBeforeMs: null },
        { start: 1_000_000, end: 1_001_000, gapBeforeMs: 999_000 },
      ],
      1000
    );
    // A timestamp exactly at a segment boundary resolves within that segment.
    expect(timeToX(blocks, 1_000_000)).toBeGreaterThan(timeToX(blocks, 1000));
  });

  it('clamps a timestamp before the first or after the last segment', () => {
    const blocks = buildTimelineLayout([{ start: 1000, end: 2000, gapBeforeMs: null }], 1000);
    expect(timeToX(blocks, 0)).toBe(0);
    expect(timeToX(blocks, 5000)).toBeCloseTo(1000, 5);
  });

  it('a zero-duration segment (single point) maps to its block midpoint', () => {
    const blocks = buildTimelineLayout([{ start: 5000, end: 5000, gapBeforeMs: null }], 1000);
    expect(timeToX(blocks, 5000)).toBeCloseTo(500, 5);
  });

  it('returns 0 for an empty layout', () => {
    expect(timeToX([], 12345)).toBe(0);
  });
});

describe('dayBoundaryIndices', () => {
  it('always includes the first entry', () => {
    const t = Date.parse('2026-01-01T12:00:00');
    expect(dayBoundaryIndices([t, t + 1000, t + 2000])).toEqual([0]);
  });

  it('marks every calendar-date change, not every 24h elapsed', () => {
    const day1a = Date.parse('2026-01-01T23:50:00');
    const day1b = Date.parse('2026-01-01T23:59:00');
    const day2 = Date.parse('2026-01-02T00:05:00'); // only 15 min after day1b, but a new calendar day
    const indices = dayBoundaryIndices([day1a, day1b, day2]);
    expect(indices).toEqual([0, 2]);
  });

  it('a long same-day session with no midnight crossing has exactly one boundary', () => {
    const base = Date.parse('2026-03-15T00:00:00');
    const timestamps = Array.from({ length: 50 }, (_, i) => base + i * 10 * 60_000); // every 10 min
    expect(dayBoundaryIndices(timestamps)).toEqual([0]);
  });

  it('a multi-week session marks each day change', () => {
    const base = Date.parse('2026-01-01T09:00:00');
    const timestamps = Array.from({ length: 14 }, (_, i) => base + i * 24 * 60 * 60_000); // once a day for 2 weeks
    expect(dayBoundaryIndices(timestamps)).toHaveLength(14); // every entry is a new day
  });

  it('returns an empty array for no timestamps', () => {
    expect(dayBoundaryIndices([])).toEqual([]);
  });
});

describe('placeLabels', () => {
  const bounds = { min: 0, max: 1000 };

  it('keeps higher-priority labels and drops ones that would overlap them', () => {
    const placed = placeLabels(
      [
        { x: 100, text: '⋯ 1h', priority: 2 },
        { x: 104, text: 'Sep 21', priority: 0 },
        { x: 400, text: '⋯ 2d', priority: 1 },
      ],
      bounds
    );
    expect(placed.map((l) => l.text)).toEqual(['Sep 21', '⋯ 2d']);
  });

  it('never returns overlapping labels, however dense the candidates', () => {
    const candidates = Array.from({ length: 200 }, (_, i) => ({ x: i * 5, text: '⋯ 1h', priority: 1 }));
    const placed = placeLabels(candidates, bounds);
    for (let i = 1; i < placed.length; i++) {
      expect(placed[i]!.x - placed[i - 1]!.x).toBeGreaterThanOrEqual('⋯ 1h'.length * 5 + 6);
    }
    expect(placed.length).toBeGreaterThan(10);
  });

  it('anchors labels at the edges so they stay inside the bounds', () => {
    const placed = placeLabels(
      [
        { x: 2, text: 'Jul 10', priority: 0 },
        { x: 998, text: '⋯ 2h', priority: 1 },
      ],
      bounds
    );
    expect(placed.map((l) => l.anchor)).toEqual(['start', 'end']);
  });
});

describe('gapShade', () => {
  const H = 3_600_000;
  it('steps at 3h, 1d and 1w', () => {
    expect(gapShade(2.9 * H)).toBe(0);
    expect(gapShade(3 * H)).toBe(1);
    expect(gapShade(23.9 * H)).toBe(1);
    expect(gapShade(24 * H)).toBe(2);
    expect(gapShade(7 * 24 * H - 1)).toBe(2);
    expect(gapShade(7 * 24 * H)).toBe(3);
  });
});

describe('calendar scale', () => {
  const D = 24 * 3_600_000;
  it('maps the ends of the span to the plot edges', () => {
    expect(calendarX(1000, 2000, 500, 1000)).toBe(0);
    expect(calendarX(1000, 2000, 500, 2000)).toBe(500);
    expect(calendarX(1000, 2000, 500, 1500)).toBe(250);
    expect(calendarX(1000, 1000, 500, 1000)).toBe(0);
  });

  it('steps ticks by 6h, a day or a week to fit the span, all inside it', () => {
    const t0 = new Date(2026, 0, 1, 9).getTime();
    expect(calendarTicks(t0, t0 + 2 * D).stepMs).toBe(6 * 3_600_000);
    expect(calendarTicks(t0, t0 + 10 * D).stepMs).toBe(D);
    const weeks = calendarTicks(t0, t0 + 30 * D);
    expect(weeks.stepMs).toBe(7 * D);
    expect(weeks.times.every((t) => t >= t0 && t <= t0 + 30 * D)).toBe(true);
  });
});
