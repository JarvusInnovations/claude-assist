/**
 * Pure layout math for the ContextTimeline chart (specs/behaviors/
 * session-context-window.md's "Timeline" section): turns the endpoint's
 * gap-collapsed segments into pixel-space blocks, and maps a real timestamp
 * to an x position within them. No React/DOM here — kept pure so it's
 * testable with plain `bun test` and reusable if the chart's shape changes.
 */

export interface LayoutSegment {
  /** Epoch ms. */
  start: number;
  end: number;
  gapBeforeMs: number | null;
}

export interface SegmentBlock {
  kind: 'segment';
  start: number;
  end: number;
  x0: number;
  x1: number;
}

export interface GapBlock {
  kind: 'gap';
  durationMs: number;
  x0: number;
  x1: number;
}

export type LayoutBlock = SegmentBlock | GapBlock;

export function isGapBlock(b: LayoutBlock): b is GapBlock {
  return b.kind === 'gap';
}

export function isSegmentBlock(b: LayoutBlock): b is SegmentBlock {
  return b.kind === 'segment';
}

/** Floor on a segment's virtual width so a short, dense burst of activity is
 * still visible rather than collapsing to zero width. */
const MIN_SEGMENT_WEIGHT_MS = 5 * 60 * 1000;

/** Every collapsed gap gets this much virtual width, regardless of how long
 * it actually was — "fixed-width break" per spec, whether the gap is 9 hours
 * or 2 weeks. Real duration is still shown via its label. */
const GAP_WEIGHT_MS = 20 * 60 * 1000;

/**
 * Lay out segments left to right across `plotWidth` pixels, each segment
 * sized proportionally to its (floored) real duration, with a fixed-width
 * gap block inserted between consecutive segments.
 */
export function buildTimelineLayout(
  segments: readonly LayoutSegment[],
  plotWidth: number
): LayoutBlock[] {
  if (segments.length === 0 || plotWidth <= 0) return [];

  const weights = segments.map((s) => Math.max(s.end - s.start, MIN_SEGMENT_WEIGHT_MS));
  const gapCount = segments.length - 1;
  const totalWeight = weights.reduce((a, b) => a + b, 0) + gapCount * GAP_WEIGHT_MS;
  if (totalWeight <= 0) return [];

  const blocks: LayoutBlock[] = [];
  let x = 0;
  segments.forEach((seg, i) => {
    if (i > 0) {
      const gapWidth = (GAP_WEIGHT_MS / totalWeight) * plotWidth;
      blocks.push({ kind: 'gap', durationMs: seg.gapBeforeMs ?? 0, x0: x, x1: x + gapWidth });
      x += gapWidth;
    }
    const segWidth = (weights[i]! / totalWeight) * plotWidth;
    blocks.push({ kind: 'segment', start: seg.start, end: seg.end, x0: x, x1: x + segWidth });
    x += segWidth;
  });
  return blocks;
}

/**
 * Map an epoch-ms timestamp to an x pixel position within a layout built by
 * `buildTimelineLayout`. A timestamp outside every segment's `[start, end]`
 * (shouldn't happen given how segments are built server-side, but keeps the
 * chart robust against an edge case) clamps to the nearest segment's edge.
 */
export function timeToX(blocks: readonly LayoutBlock[], tsMs: number): number {
  const segmentBlocks = blocks.filter(isSegmentBlock);
  if (segmentBlocks.length === 0) return 0;

  for (const b of segmentBlocks) {
    if (tsMs >= b.start && tsMs <= b.end) {
      if (b.end === b.start) return (b.x0 + b.x1) / 2;
      const frac = (tsMs - b.start) / (b.end - b.start);
      return b.x0 + frac * (b.x1 - b.x0);
    }
  }
  if (tsMs < segmentBlocks[0]!.start) return segmentBlocks[0]!.x0;
  return segmentBlocks[segmentBlocks.length - 1]!.x1;
}

/**
 * Indices in a chronologically-ordered list of epoch-ms timestamps where the
 * local calendar date changes from the previous entry — "Day boundaries are
 * marked with a date label" (spec). The first entry is always included (it
 * starts the first day's label). Local time, not UTC, since that's what the
 * chart displays.
 */
export function dayBoundaryIndices(timestampsMs: readonly number[]): number[] {
  const indices: number[] = [];
  let lastDateKey = '';
  timestampsMs.forEach((ms, i) => {
    const dateKey = new Date(ms).toDateString();
    if (dateKey !== lastDateKey) {
      indices.push(i);
      lastDateKey = dateKey;
    }
  });
  return indices;
}
