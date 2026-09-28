/**
 * Pure shaping functions for `GET /sessions/:id/context-timeline`
 * (specs/behaviors/session-context-window.md's "Timeline" section): the
 * active-time-axis gap collapse and the bucketed downsampling. No database
 * access here — `routes.ts` owns the query and calls these on the rows it
 * fetched.
 */

/** Gap threshold above which a break in the active-time axis is collapsed
 * (matches the 30-minute activity-range gap used elsewhere in this package). */
export const TIMELINE_GAP_MS = 30 * 60 * 1000;

/** Default ceiling on downsampled reading points the endpoint returns. */
export const DEFAULT_MAX_READINGS = 600;

export interface TimelineSegment {
  start: string;
  end: string;
  /** Duration of the collapsed gap immediately preceding this segment, in
   * milliseconds — `null` for the first segment (nothing precedes it). */
  gapBeforeMs: number | null;
}

/**
 * Active-time-axis segmentation. Takes every event's timestamp — readings
 * *and* compactions, not just the downsampled readings, so a real gap is
 * never hidden inside a bucket that happens to straddle it — and returns
 * contiguous segments plus the collapsed-gap duration before each one after
 * the first. Input need not be sorted.
 */
export function computeTimelineSegments(
  timestamps: readonly Date[],
  gapMs: number = TIMELINE_GAP_MS
): TimelineSegment[] {
  if (timestamps.length === 0) return [];
  const sorted = [...timestamps].sort((a, b) => a.getTime() - b.getTime());

  const segments: TimelineSegment[] = [];
  let segStart = sorted[0]!;
  let segEnd = sorted[0]!;
  let gapBeforeMs: number | null = null;

  for (let i = 1; i < sorted.length; i++) {
    const ts = sorted[i]!;
    const delta = ts.getTime() - segEnd.getTime();
    if (delta > gapMs) {
      segments.push({ start: segStart.toISOString(), end: segEnd.toISOString(), gapBeforeMs });
      segStart = ts;
      gapBeforeMs = delta;
    }
    segEnd = ts;
  }
  segments.push({ start: segStart.toISOString(), end: segEnd.toISOString(), gapBeforeMs });
  return segments;
}

/**
 * Bucket-downsample readings (already sorted by `ts` ascending) to at most
 * ~`maxPoints` total points, keeping each bucket's **maximum** reading and
 * its **last** reading — so the global peak always survives (it lives inside
 * whichever bucket contains it, and that bucket's max IS the global max) and
 * a post-compaction drop stays visible at the bucket boundary. A bucket whose
 * max reading is also its last contributes one point, not two, which is why
 * the output can be under, not just at, the nominal ceiling.
 *
 * A no-op (returns the input unchanged) when it's already at or under the
 * ceiling.
 */
export function downsampleReadings<T extends { tokens: number }>(
  readings: readonly T[],
  maxPoints: number = DEFAULT_MAX_READINGS
): T[] {
  if (readings.length <= maxPoints) return [...readings];

  // Each bucket can contribute up to 2 points (max + last), so aim for
  // maxPoints/2 buckets to keep the total at or under the ceiling.
  const bucketCount = Math.max(1, Math.floor(maxPoints / 2));
  const bucketSize = Math.ceil(readings.length / bucketCount);

  const out: T[] = [];
  for (let i = 0; i < readings.length; i += bucketSize) {
    const bucket = readings.slice(i, i + bucketSize);
    let maxItem = bucket[0]!;
    for (const r of bucket) {
      if (r.tokens > maxItem.tokens) maxItem = r;
    }
    const lastItem = bucket[bucket.length - 1]!;
    out.push(maxItem);
    if (lastItem !== maxItem) out.push(lastItem);
  }
  return out;
}
