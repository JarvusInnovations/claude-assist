import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { ArrowLeft } from "lucide-react";
import { useState, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { sessionsApi } from "@/api/sessions";
import type { ActivityRange, ActivitySession } from "@/types/api";

// Hours displayed on the timeline (6 AM to 5 AM next day = 23 hours)
const START_HOUR = 6;
const TOTAL_HOURS = 23;
const HOUR_HEIGHT_PX = 40;
const TIMELINE_HEIGHT = TOTAL_HOURS * HOUR_HEIGHT_PX;

// Color palette for projects (HSL hues, evenly spaced)
const PROJECT_COLORS = [
  "hsl(210, 70%, 55%)", // blue
  "hsl(150, 60%, 45%)", // green
  "hsl(30, 80%, 55%)",  // orange
  "hsl(270, 60%, 55%)", // purple
  "hsl(350, 70%, 55%)", // red
  "hsl(180, 60%, 45%)", // teal
  "hsl(60, 70%, 45%)",  // yellow
  "hsl(310, 60%, 55%)", // pink
  "hsl(90, 50%, 45%)",  // lime
  "hsl(240, 50%, 60%)", // indigo
];

/** Home directory patterns — strip to get relative paths */
const HOME_PATTERN = /^\/(?:Users|home)\/\w+\//;
/** Known repo root containers (immediately under home) */
const REPO_CONTAINERS = new Set(["Repositories", "repos"]);
/** Worktree patterns that extract a repo name directly */
const WORKTREE_PATTERNS = [
  /\/conductor\/workspaces\/([^/]+)/,   // conductor/workspaces/<repo>/<worktree>
  /\.claude-worktrees\/([^/]+)/,         // .claude-worktrees/<repo>/<worktree>
];

/**
 * Build a mapping from raw project paths to display names.
 *
 * Strategy:
 * 1. Extract repo name from worktree patterns
 * 2. Identify repo roots: ~/Repositories/<repo> and ~/<repo> paths
 * 3. Collapse any path that is a subdirectory of a known repo root
 */
function buildProjectNames(paths: Set<string>): Map<string, string> {
  const result = new Map<string, string>();

  // Phase 1: handle worktree patterns (these always resolve to a repo name)
  const remaining = new Set<string>();
  for (const path of paths) {
    let matched = false;
    for (const pattern of WORKTREE_PATTERNS) {
      const m = path.match(pattern);
      if (m) {
        result.set(path, m[1]!);
        matched = true;
        break;
      }
    }
    if (!matched) remaining.add(path);
  }

  // Phase 2: normalize remaining paths to home-relative form
  // e.g. "/Users/chris/Repositories/hologit/tf" → "Repositories/hologit/tf"
  // e.g. "/home/chris/claude-assist" → "claude-assist"
  const homeRelative = new Map<string, string>();
  for (const path of remaining) {
    const rel = path.replace(HOME_PATTERN, "");
    homeRelative.set(path, rel);
  }

  // Phase 3: identify repo roots
  // ~/Repositories/<name> or ~/repos/<name> → repo root is the first two components
  // ~/<name> → repo root is the first component
  const repoRoots = new Set<string>();
  for (const rel of homeRelative.values()) {
    const parts = rel.split("/");
    if (parts.length >= 2 && REPO_CONTAINERS.has(parts[0]!)) {
      repoRoots.add(parts[0] + "/" + parts[1]);
    } else if (parts[0]) {
      repoRoots.add(parts[0]);
    }
  }

  // Phase 4: for each remaining path, find its repo root and use that as the name
  for (const [path, rel] of homeRelative) {
    // Find the longest matching repo root
    let bestRoot = "";
    for (const root of repoRoots) {
      if ((rel === root || rel.startsWith(root + "/")) && root.length > bestRoot.length) {
        bestRoot = root;
      }
    }

    if (bestRoot) {
      // Extract just the repo name (last component of the root)
      const parts = bestRoot.split("/");
      result.set(path, parts[parts.length - 1]!);
    } else {
      result.set(path, rel || path);
    }
  }

  return result;
}

function getProjectColor(projectName: string, projectIndex: Map<string, number>): string {
  const idx = projectIndex.get(projectName) ?? 0;
  return PROJECT_COLORS[idx % PROJECT_COLORS.length]!;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Convert a Date to a fractional hour offset from START_HOUR, handling day wrap */
function toTimelineOffset(date: Date): number {
  const hours = date.getHours() + date.getMinutes() / 60;
  let offset = hours - START_HOUR;
  if (offset < 0) offset += 24; // wrap for hours before START_HOUR (e.g., 2am)
  return offset;
}

/** Get the calendar date key (YYYY-MM-DD) for a timestamp, using our day boundary */
function toDayKey(date: Date): string {
  // If before START_HOUR, it belongs to the previous calendar day
  const adjusted = new Date(date);
  if (adjusted.getHours() < START_HOUR) {
    adjusted.setDate(adjusted.getDate() - 1);
  }
  return adjusted.toISOString().slice(0, 10);
}

interface BarData {
  sessionId: string;
  title: string | null;
  projectPath: string | null;
  start: Date;
  end: Date;
  topPct: number;
  heightPct: number;
}

function buildBars(
  sessions: ActivitySession[],
  dayKey: string
): BarData[] {
  const bars: BarData[] = [];

  for (const session of sessions) {
    for (const range of session.activity_ranges) {
      const start = new Date(range.start);
      const end = new Date(range.end);

      // Check if this range falls on this day (using our day boundary)
      const rangeDay = toDayKey(start);
      if (rangeDay !== dayKey) continue;

      const startOffset = toTimelineOffset(start);
      const endOffset = toTimelineOffset(end);
      // Ensure minimum visible height (3px worth)
      const minPct = (3 / TIMELINE_HEIGHT) * 100;
      const rawHeight = ((endOffset - startOffset) / TOTAL_HOURS) * 100;

      bars.push({
        sessionId: session.id,
        title: session.title,
        projectPath: session.project_path,
        start,
        end,
        topPct: (startOffset / TOTAL_HOURS) * 100,
        heightPct: Math.max(rawHeight, minPct),
      });
    }
  }

  return bars;
}

export function ActivityPage() {
  const navigate = useNavigate();
  const [tooltip, setTooltip] = useState<{
    bar: BarData;
    x: number;
    y: number;
  } | null>(null);

  const { data: sessions, isLoading } = useQuery({
    queryKey: ["sessions", "activity", 7],
    queryFn: () => sessionsApi.getActivity(7),
  });

  // Build normalized project name mapping and color index
  const { projectNames, projectIndex } = useMemo(() => {
    if (!sessions) return { projectNames: new Map<string, string>(), projectIndex: new Map<string, number>() };
    const rawPaths = new Set<string>();
    for (const s of sessions) {
      rawPaths.add(s.project_path ?? "(no project)");
    }
    const names = buildProjectNames(rawPaths);
    // Deduplicate normalized names and assign color indices
    const uniqueNames = [...new Set(names.values())];
    const index = new Map<string, number>();
    uniqueNames.forEach((name, i) => index.set(name, i));
    return { projectNames: names, projectIndex: index };
  }, [sessions]);

  // Build last 7 day keys
  const dayKeys = useMemo(() => {
    const keys: string[] = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      keys.push(d.toISOString().slice(0, 10));
    }
    return keys;
  }, []);

  const formatDayHeader = (dayKey: string) => {
    const date = new Date(dayKey + "T12:00:00");
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (dayKey === today) return "Today";
    if (dayKey === yesterday) return "Yesterday";
    return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  };

  // Hour labels
  const hourLabels = useMemo(() => {
    const labels: { hour: number; label: string; pct: number }[] = [];
    for (let i = 0; i < TOTAL_HOURS; i++) {
      const hour = (START_HOUR + i) % 24;
      const ampm = hour >= 12 ? "pm" : "am";
      const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
      labels.push({
        hour,
        label: `${h12}${ampm}`,
        pct: (i / TOTAL_HOURS) * 100,
      });
    }
    return labels;
  }, []);

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/sessions">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Sessions
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold">Activity</h1>
            <p className="text-muted-foreground text-sm">Last 7 days</p>
          </div>
        </div>
      </div>

      {/* Legend */}
      {sessions && (
        <div className="flex flex-wrap gap-3 text-sm">
          {[...projectIndex.entries()].map(([name, idx]) => (
            <div key={name} className="flex items-center gap-1.5">
              <div
                className="w-3 h-3 rounded-sm"
                style={{ backgroundColor: PROJECT_COLORS[idx % PROJECT_COLORS.length] }}
              />
              <span className="text-muted-foreground">{name}</span>
            </div>
          ))}
        </div>
      )}

      {isLoading ? (
        <Skeleton className="h-[600px] w-full" />
      ) : (
        /* Timeline grid */
        <div
          className="grid gap-0 border rounded-lg overflow-hidden bg-background"
          style={{ gridTemplateColumns: "48px repeat(7, 1fr)" }}
        >
          {/* Header row */}
          <div className="border-b border-r bg-muted/50 p-2" />
          {dayKeys.map((dk) => (
            <div key={dk} className="border-b border-r last:border-r-0 bg-muted/50 px-2 py-2 text-center text-sm font-medium">
              {formatDayHeader(dk)}
            </div>
          ))}

          {/* Time axis + day columns */}
          <div className="relative border-r" style={{ height: TIMELINE_HEIGHT }}>
            {hourLabels.map((h) => (
              <div
                key={h.hour}
                className="absolute right-2 text-xs text-muted-foreground -translate-y-1/2"
                style={{ top: `${h.pct}%` }}
              >
                {h.label}
              </div>
            ))}
          </div>

          {dayKeys.map((dk) => {
            const bars = sessions ? buildBars(sessions, dk) : [];

            // Group overlapping bars into columns
            const barColumns: number[] = [];
            const columnEnds: number[] = [];
            for (const bar of bars.sort((a, b) => a.topPct - b.topPct)) {
              let col = 0;
              for (col = 0; col < columnEnds.length; col++) {
                if (bar.topPct >= columnEnds[col]!) break;
              }
              barColumns.push(col);
              columnEnds[col] = bar.topPct + bar.heightPct;
            }
            const maxCol = Math.max(0, ...barColumns) + 1;

            return (
              <div
                key={dk}
                className="relative border-r last:border-r-0"
                style={{ height: TIMELINE_HEIGHT }}
              >
                {/* Hour gridlines */}
                {hourLabels.map((h) => (
                  <div
                    key={h.hour}
                    className="absolute left-0 right-0 border-t border-border/30"
                    style={{ top: `${h.pct}%` }}
                  />
                ))}

                {/* Activity bars */}
                {bars.sort((a, b) => a.topPct - b.topPct).map((bar, i) => {
                  const col = barColumns[i]!;
                  const widthPct = 100 / maxCol;
                  const leftPct = col * widthPct;

                  return (
                    <div
                      key={`${bar.sessionId}-${bar.start.getTime()}`}
                      className="absolute rounded-sm cursor-pointer transition-opacity hover:opacity-80"
                      style={{
                        top: `${bar.topPct}%`,
                        height: `${bar.heightPct}%`,
                        left: `calc(${leftPct}% + 2px)`,
                        width: `calc(${widthPct}% - 4px)`,
                        backgroundColor: getProjectColor(
                          projectNames.get(bar.projectPath ?? "(no project)") ?? bar.projectPath ?? "",
                          projectIndex
                        ),
                        minHeight: 3,
                      }}
                      onClick={() => navigate(`/sessions/${bar.sessionId}`)}
                      onMouseEnter={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setTooltip({ bar, x: rect.left + rect.width / 2, y: rect.top });
                      }}
                      onMouseLeave={() => setTooltip(null)}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 px-3 py-2 rounded-lg shadow-lg border bg-popover text-popover-foreground text-sm pointer-events-none max-w-xs"
          style={{
            left: tooltip.x,
            top: tooltip.y - 8,
            transform: "translate(-50%, -100%)",
          }}
        >
          <div className="font-medium">{tooltip.bar.title ?? tooltip.bar.sessionId.slice(0, 8)}</div>
          <div className="text-muted-foreground text-xs">
            {projectNames.get(tooltip.bar.projectPath ?? "(no project)") ?? tooltip.bar.projectPath}
          </div>
          <div className="text-muted-foreground text-xs">
            {formatTime(tooltip.bar.start)} - {formatTime(tooltip.bar.end)}
            {" "}
            ({formatDuration(tooltip.bar.end.getTime() - tooltip.bar.start.getTime())})
          </div>
        </div>
      )}
    </div>
  );
}
