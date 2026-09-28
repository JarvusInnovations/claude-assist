import { useMemo, useState, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { sessionsApi } from "@/api/sessions";
import {
  buildTimelineLayout,
  timeToX,
  isGapBlock,
  dayBoundaryIndices,
  type LayoutBlock,
} from "@/lib/timeline-layout";

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 220;
const PAD = { top: 16, right: 16, bottom: 28, left: 56 };
const PLOT_WIDTH = VIEW_WIDTH - PAD.left - PAD.right;
const PLOT_HEIGHT = VIEW_HEIGHT - PAD.top - PAD.bottom;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatGap(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 24) return `⋯ ${Math.max(1, Math.round(hours))}h`;
  return `⋯ ${Math.round(hours / 24)}d`;
}

function formatDayLabel(tsMs: number): string {
  return new Date(tsMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The context-timeline chart (specs/behaviors/session-context-window.md's
 * "Timeline" section): a line of context tokens over the active-time axis,
 * with a limit ceiling when known, compaction markers annotated with their
 * drop, gap breaks, day labels, and a hover readout. Inline SVG, no chart
 * dependency — the geometry lives in `@/lib/timeline-layout` so it's testable
 * without React.
 */
export function ContextTimeline({ sessionId }: { sessionId: string }) {
  const { data } = useQuery({
    queryKey: ["sessions", sessionId, "context-timeline"],
    queryFn: () => sessionsApi.getContextTimeline(sessionId),
  });
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const layout = useMemo<LayoutBlock[]>(() => {
    if (!data) return [];
    return buildTimelineLayout(
      data.segments.map((s) => ({
        start: Date.parse(s.start),
        end: Date.parse(s.end),
        gapBeforeMs: s.gap_before_ms,
      })),
      PLOT_WIDTH
    );
  }, [data]);

  // Spec: "A session with fewer than two readings shows no chart."
  if (!data || data.readings.length < 2) return null;

  const xFor = (iso: string) => PAD.left + timeToX(layout, Date.parse(iso));

  const yMax =
    Math.max(
      data.limit ?? 0,
      ...data.readings.map((r) => r.tokens),
      ...data.compactions.map((c) => c.pre_tokens ?? 0)
    ) * 1.05 || 1;
  const yFor = (tokens: number) => PAD.top + (1 - tokens / yMax) * PLOT_HEIGHT;

  const points = data.readings.map((r) => ({ x: xFor(r.ts), y: yFor(r.tokens), reading: r }));
  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");

  const readingTimestampsMs = data.readings.map((r) => Date.parse(r.ts));
  const dayLabels = dayBoundaryIndices(readingTimestampsMs).map((i) => ({
    x: xFor(data.readings[i]!.ts),
    label: formatDayLabel(readingTimestampsMs[i]!),
  }));

  const gapBlocks = layout.filter(isGapBlock);

  const handleMouseMove = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const px = ((event.clientX - rect.left) / rect.width) * VIEW_WIDTH;
    let nearest = 0;
    let nearestDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(p.x - px);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = i;
      }
    });
    setHoverIndex(nearest);
  };

  const hovered = hoverIndex !== null ? (points[hoverIndex] ?? null) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Context Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          className="w-full h-auto select-none"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          {/* plot border */}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={PLOT_WIDTH}
            height={PLOT_HEIGHT}
            className="fill-none stroke-border"
          />

          {/* collapsed-gap bands */}
          {gapBlocks.map((g, i) => (
            <g key={`gap-${i}`}>
              <rect
                x={PAD.left + g.x0}
                y={PAD.top}
                width={Math.max(g.x1 - g.x0, 1)}
                height={PLOT_HEIGHT}
                className="fill-muted"
              />
              <text
                x={PAD.left + (g.x0 + g.x1) / 2}
                y={VIEW_HEIGHT - PAD.bottom + 14}
                textAnchor="middle"
                className="fill-muted-foreground text-[9px]"
              >
                {formatGap(g.durationMs)}
              </text>
            </g>
          ))}

          {/* day labels */}
          {dayLabels.map((d, i) => (
            <text
              key={`day-${i}`}
              x={d.x}
              y={VIEW_HEIGHT - PAD.bottom + 14}
              textAnchor="middle"
              className="fill-muted-foreground text-[9px]"
            >
              {d.label}
            </text>
          ))}

          {/* limit ceiling — only when known (never a fabricated denominator) */}
          {data.limit !== null && (
            <>
              <line
                x1={PAD.left}
                x2={VIEW_WIDTH - PAD.right}
                y1={yFor(data.limit)}
                y2={yFor(data.limit)}
                className="stroke-muted-foreground"
                strokeDasharray="4 3"
              />
              <text
                x={VIEW_WIDTH - PAD.right}
                y={yFor(data.limit) - 4}
                textAnchor="end"
                className="fill-muted-foreground text-[9px]"
              >
                limit {formatTokens(data.limit)}
              </text>
            </>
          )}

          {/* compaction markers, annotated with their drop */}
          {data.compactions.map((c, i) => {
            if (!c.ts) return null;
            const x = xFor(c.ts);
            return (
              <g key={`compaction-${i}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={PAD.top}
                  y2={VIEW_HEIGHT - PAD.bottom}
                  className="stroke-destructive"
                  strokeDasharray="2 3"
                  strokeOpacity={0.7}
                />
                <text x={x} y={PAD.top - 5} textAnchor="middle" className="fill-destructive text-[9px]">
                  {c.pre_tokens !== null && c.post_tokens !== null
                    ? `${formatTokens(c.pre_tokens)} → ${formatTokens(c.post_tokens)}`
                    : (c.trigger ?? "compaction")}
                </text>
              </g>
            );
          })}

          {/* the context-token line */}
          <path d={pathD} fill="none" className="stroke-chart-1" strokeWidth={1.5} />

          {/* hover guide + point */}
          {hovered && (
            <>
              <line
                x1={hovered.x}
                x2={hovered.x}
                y1={PAD.top}
                y2={VIEW_HEIGHT - PAD.bottom}
                className="stroke-foreground"
                strokeOpacity={0.25}
              />
              <circle cx={hovered.x} cy={hovered.y} r={3} className="fill-chart-1" />
            </>
          )}
        </svg>
        <p className="mt-1 text-xs text-muted-foreground tabular-nums">
          {hovered
            ? `${new Date(hovered.reading.ts).toLocaleString()} — ${hovered.reading.tokens.toLocaleString()} tokens`
            : "Hover the chart for a reading."}
        </p>
      </CardContent>
    </Card>
  );
}
