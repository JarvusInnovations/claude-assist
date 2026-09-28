import { useMemo, useState, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { sessionsApi } from "@/api/sessions";
import {
  buildTimelineLayout,
  timeToX,
  isGapBlock,
  isSegmentBlock,
  dayBoundaryIndices,
  placeLabels,
  gapShade,
  calendarX,
  calendarTicks,
  type LayoutBlock,
} from "@/lib/timeline-layout";

const VIEW_WIDTH = 1000;
const CHART_HEIGHT = 220;
const RULER_HEIGHT = 40;
const PAD = { top: 16, right: 16, bottom: 28, left: 56 };
const PLOT_WIDTH = VIEW_WIDTH - PAD.left - PAD.right;
const PLOT_HEIGHT = CHART_HEIGHT - PAD.top - PAD.bottom;
const PLOT_BOTTOM = PAD.top + PLOT_HEIGHT;
const IDLE_MS = 30 * 60 * 1000;

/** Gap-band opacity per shade step (under 3h, 3h–1d, 1d–1w, over a week). */
const SHADE_OPACITY = [0.06, 0.14, 0.28, 0.45] as const;
const SHADE_LEGEND = ["under 3h", "3h–1d", "1d–1w", "over 1w"] as const;

type View = "active" | "calendar";
const VIEWS: { id: View; label: string; title: string }[] = [
  { id: "active", label: "Active", title: "Active time: idle gaps collapsed, with a calendar strip below" },
  { id: "calendar", label: "Calendar", title: "Calendar time: true time, idle periods included" },
];
const VIEW_KEY = "claude-assist.context-timeline.view";

function loadView(): View {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    // Earlier "condensed"/"ruler" views are both the Active view now.
    return v === "calendar" ? "calendar" : "active";
  } catch {
    return "active";
  }
}

function saveView(v: View) {
  try {
    window.localStorage.setItem(VIEW_KEY, v);
  } catch {
    // Storage unavailable (private window, blocked site data): the view just isn't remembered.
  }
}

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

function formatCompaction(c: { pre_tokens: number | null; post_tokens: number | null; trigger: string | null }): string {
  if (c.pre_tokens === null) return c.trigger ?? "compaction";
  return `${formatTokens(c.pre_tokens)} → ${c.post_tokens === null ? "?" : formatTokens(c.post_tokens)}`;
}

function formatDayLabel(tsMs: number): string {
  return new Date(tsMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface AxisLabel {
  x: number;
  text: string;
  priority: number;
  bold?: boolean;
}

/**
 * The context-timeline chart (specs/behaviors/session-context-window.md's
 * "Timeline" section). Two views: Active time (active-time axis with
 * log-scaled, graded gap breaks, plus a true-time strip below) and Calendar
 * time (true time, line broken across idles). Inline SVG, no chart
 * dependency — the geometry lives in `@/lib/timeline-layout` so it's testable
 * without React.
 */
export function ContextTimeline({ sessionId }: { sessionId: string }) {
  const { data } = useQuery({
    queryKey: ["sessions", sessionId, "context-timeline"],
    queryFn: () => sessionsApi.getContextTimeline(sessionId),
  });
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [view, setView] = useState<View>(loadView);

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

  const calendar = view === "calendar";
  const viewHeight = CHART_HEIGHT + (calendar ? 0 : RULER_HEIGHT);
  const t0 = Date.parse(data.segments[0]?.start ?? data.readings[0]!.ts);
  const t1 = Date.parse(data.segments.at(-1)?.end ?? data.readings.at(-1)!.ts);

  const xAt = (tsMs: number) =>
    PAD.left + (calendar ? calendarX(t0, t1, PLOT_WIDTH, tsMs) : timeToX(layout, tsMs));
  const xFor = (iso: string) => xAt(Date.parse(iso));

  const yMax =
    Math.max(
      data.limit ?? 0,
      ...data.readings.map((r) => r.tokens),
      ...data.compactions.map((c) => c.pre_tokens ?? 0)
    ) * 1.05 || 1;
  const yFor = (tokens: number) => PAD.top + (1 - tokens / yMax) * PLOT_HEIGHT;

  const points = data.readings.map((r) => ({ x: xFor(r.ts), y: yFor(r.tokens), t: Date.parse(r.ts), reading: r }));
  // Calendar breaks the line across idle time; the active view connects
  // through the collapsed breaks.
  const pathD = points
    .map((p, i) => {
      const move = i === 0 || (calendar && p.t - points[i - 1]!.t > IDLE_MS);
      return `${move ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    })
    .join(" ");

  const gapBlocks = layout.filter(isGapBlock);
  const bounds = { min: PAD.left, max: VIEW_WIDTH - PAD.right };

  // Axis labels. Active: day boundaries and gap breaks; a gap of a
  // day or more that ends at a day boundary shares its label ("⋯ 23d · Aug 3")
  // and outranks a plain day label. Calendar: evenly stepped ticks.
  let axisCandidates: AxisLabel[];
  if (calendar) {
    const { times, stepMs } = calendarTicks(t0, t1);
    axisCandidates = times.map((t) => ({
      x: xAt(t),
      text: stepMs >= 86_400_000 ? formatDayLabel(t) : new Date(t).toLocaleTimeString(undefined, { hour: "numeric" }),
      priority: 0,
    }));
  } else {
    const readingTimestampsMs = points.map((p) => p.t);
    const dayLabels = dayBoundaryIndices(readingTimestampsMs).map((i) => ({
      x: points[i]!.x,
      label: formatDayLabel(readingTimestampsMs[i]!),
    }));
    const mergedGaps = new Set<number>();
    const dayCandidates: AxisLabel[] = dayLabels.map((d) => {
      const gi = gapBlocks.findIndex(
        (g, i) => !mergedGaps.has(i) && g.durationMs >= 86_400_000 && Math.abs(PAD.left + g.x1 - d.x) < 2
      );
      if (gi < 0) return { x: d.x, text: d.label, priority: 0 };
      mergedGaps.add(gi);
      return { x: d.x, text: `${formatGap(gapBlocks[gi]!.durationMs)} · ${d.label}`, priority: -1, bold: true };
    });
    axisCandidates = [
      ...dayCandidates,
      ...gapBlocks
        .filter((_, i) => !mergedGaps.has(i))
        .map((g) => ({
          x: PAD.left + (g.x0 + g.x1) / 2,
          text: formatGap(g.durationMs),
          priority: g.durationMs >= 86_400_000 ? 1 : 2,
          bold: g.durationMs >= 86_400_000,
        })),
    ];
  }
  const boldByText = new Map(axisCandidates.map((c) => [`${c.x}|${c.text}`, !!c.bold]));
  const axisLabels = placeLabels(axisCandidates, bounds).map((l) => ({
    ...l,
    bold: boldByText.get(`${l.x}|${l.text}`) ?? false,
  }));

  const compactionMarks = data.compactions
    .filter((c) => c.ts)
    .map((c) => ({ x: xFor(c.ts!), text: formatCompaction(c), trigger: c.trigger, pre: c.pre_tokens ?? 0 }));
  // Annotate the biggest drops first when markers crowd each other; every
  // marker still carries a hover title.
  const compactionLabels = placeLabels(
    compactionMarks.map((m) => ({ x: m.x, text: m.text, priority: -m.pre })),
    bounds
  );

  const yTicks = [0, yMax / 2, yMax];

  // Calendar idle bands: between consecutive active stretches.
  const idleBands = calendar
    ? data.segments.slice(1).map((s, i) => ({
        x0: xAt(Date.parse(data.segments[i]!.end)),
        x1: xAt(Date.parse(s.start)),
      }))
    : [];

  // Active view's calendar strip: each active stretch in true time, below the chart.
  const rulerTop = CHART_HEIGHT + 6;
  const rulerX = (t: number) => PAD.left + calendarX(t0, t1, PLOT_WIDTH, t);
  const rulerSegments =
    !calendar
      ? layout.filter(isSegmentBlock).map((b) => {
          const a = rulerX(b.start);
          return { cx0: PAD.left + b.x0, cx1: PAD.left + b.x1, rx0: a, rx1: Math.max(rulerX(b.end), a + 1) };
        })
      : [];
  const rulerLabels =
    !calendar
      ? placeLabels(
          calendarTicks(t0, t1).times.map((t) => ({ x: rulerX(t), text: formatDayLabel(t), priority: 0 })),
          bounds
        )
      : [];

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

  const selectView = (v: View) => {
    setView(v);
    saveView(v);
    setHoverIndex(null);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-lg">Context Timeline</CardTitle>
        <div className="flex gap-1" role="group" aria-label="Timeline view">
          {VIEWS.map((v) => (
            <Button
              key={v.id}
              size="sm"
              variant={view === v.id ? "secondary" : "ghost"}
              aria-pressed={view === v.id}
              title={v.title}
              onClick={() => selectView(v.id)}
            >
              {v.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${viewHeight}`}
          className="w-full h-auto select-none"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          {/* plot border */}
          <rect x={PAD.left} y={PAD.top} width={PLOT_WIDTH} height={PLOT_HEIGHT} className="fill-none stroke-border" />

          {/* active view: collapsed-gap breaks, shaded darker with duration */}
          {!calendar &&
            gapBlocks.map((g, i) => (
              <rect
                key={`gap-${i}`}
                x={PAD.left + g.x0}
                y={PAD.top}
                width={Math.max(g.x1 - g.x0, 1)}
                height={PLOT_HEIGHT}
                className="fill-muted-foreground"
                fillOpacity={SHADE_OPACITY[gapShade(g.durationMs)]}
              />
            ))}

          {/* calendar: idle periods between active stretches */}
          {idleBands.map((b, i) => (
            <rect
              key={`idle-${i}`}
              x={b.x0}
              y={PAD.top}
              width={Math.max(b.x1 - b.x0, 0.5)}
              height={PLOT_HEIGHT}
              className="fill-muted-foreground"
              fillOpacity={SHADE_OPACITY[0]}
            />
          ))}

          {/* y-axis ticks and gridlines */}
          {yTicks.map((t, i) => (
            <g key={`ytick-${i}`}>
              {i > 0 && (
                <line
                  x1={PAD.left}
                  x2={VIEW_WIDTH - PAD.right}
                  y1={yFor(t)}
                  y2={yFor(t)}
                  className="stroke-border"
                  strokeOpacity={0.5}
                />
              )}
              <text x={PAD.left - 6} y={yFor(t) + 3} textAnchor="end" className="fill-muted-foreground text-[9px]">
                {formatTokens(t)}
              </text>
            </g>
          ))}

          {/* x-axis labels, collision-free */}
          {axisLabels.map((l, i) => (
            <text
              key={`axis-${i}`}
              x={l.x}
              y={PLOT_BOTTOM + 14}
              textAnchor={l.anchor}
              className={l.bold ? "fill-foreground text-[9px] font-semibold" : "fill-muted-foreground text-[9px]"}
            >
              {l.text}
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
                x={PAD.left + 4}
                y={yFor(data.limit) + 10}
                textAnchor="start"
                className="fill-muted-foreground text-[9px]"
              >
                limit {formatTokens(data.limit)}
              </text>
            </>
          )}

          {/* compaction markers; the biggest drops get a label, all get a hover title */}
          {compactionMarks.map((m, i) => (
            <g key={`compaction-${i}`}>
              <title>{`Compaction (${m.trigger ?? "unknown trigger"}): ${m.text}`}</title>
              <line
                x1={m.x}
                x2={m.x}
                y1={PAD.top}
                y2={PLOT_BOTTOM}
                className="stroke-destructive"
                strokeDasharray="2 3"
                strokeOpacity={0.7}
              />
            </g>
          ))}
          {compactionLabels.map((l, i) => (
            <text
              key={`compaction-label-${i}`}
              x={l.x}
              y={PAD.top - 5}
              textAnchor={l.anchor}
              className="fill-destructive text-[9px]"
            >
              {l.text}
            </text>
          ))}

          {/* the context-token line */}
          <path d={pathD} fill="none" className="stroke-chart-1" strokeWidth={1.5} />

          {/* active view: true-time strip with connectors from each active stretch */}
          {!calendar && (
            <g>
              {rulerSegments.map((s, i) => (
                <polygon
                  key={`conn-${i}`}
                  points={`${s.cx0},${PLOT_BOTTOM + 18} ${s.cx1},${PLOT_BOTTOM + 18} ${s.rx1},${rulerTop} ${s.rx0},${rulerTop}`}
                  className="fill-chart-1"
                  fillOpacity={0.1}
                />
              ))}
              <rect
                x={PAD.left}
                y={rulerTop}
                width={PLOT_WIDTH}
                height={8}
                className="fill-muted-foreground stroke-border"
                fillOpacity={SHADE_OPACITY[0]}
              />
              {rulerSegments.map((s, i) => (
                <rect key={`rs-${i}`} x={s.rx0} y={rulerTop} width={s.rx1 - s.rx0} height={8} className="fill-chart-1" />
              ))}
              {rulerLabels.map((l, i) => (
                <text
                  key={`rl-${i}`}
                  x={l.x}
                  y={rulerTop + 20}
                  textAnchor={l.anchor}
                  className="fill-muted-foreground text-[9px]"
                >
                  {l.text}
                </text>
              ))}
            </g>
          )}

          {/* hover guide + point */}
          {hovered && (
            <>
              <line
                x1={hovered.x}
                x2={hovered.x}
                y1={PAD.top}
                y2={PLOT_BOTTOM}
                className="stroke-foreground"
                strokeOpacity={0.25}
              />
              <circle cx={hovered.x} cy={hovered.y} r={3} className="fill-chart-1" />
            </>
          )}
        </svg>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <p className="tabular-nums">
            {hovered
              ? `${new Date(hovered.reading.ts).toLocaleString()} — ${hovered.reading.tokens.toLocaleString()} tokens`
              : "Hover the chart for a reading."}
          </p>
          {!calendar && (
            <div className="flex flex-wrap items-center gap-3" aria-label="Gap shading legend">
              <span>Idle gaps:</span>
              {SHADE_LEGEND.map((label, i) => (
                <span key={label} className="flex items-center gap-1">
                  <svg width="12" height="9" aria-hidden="true">
                    <rect width="12" height="9" rx="1" className="fill-muted-foreground" fillOpacity={SHADE_OPACITY[i]} />
                  </svg>
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
