import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { ScrollText, RefreshCw, Sparkles, Activity, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { sessionsApi } from "@/api/sessions";
import type { SessionQueryParams, SessionRecord } from "@/types/api";

const HOUR_MS = 60 * 60 * 1000;

/** Sessions are ordered by this server-side: last message timestamp, else start. */
const lastActivityAt = (session: SessionRecord) =>
  new Date(session.ended_at ?? session.started_at).getTime();

const formatSinceActivity = (elapsedMs: number) => {
  const minutes = Math.floor(elapsedMs / 60_000);
  return minutes < 1 ? "just now" : `${minutes}m ago`;
};

/**
 * Context occupancy as a fraction, or null when it was never measured or the
 * model's window is unknown — a bar drawn against a guessed ceiling would be
 * indistinguishable from a measured one.
 */
const contextFraction = (session: SessionRecord) => {
  const used = session.context_final_tokens;
  const limit = session.context_limit_tokens;
  if (used === null || limit === null || limit <= 0) return null;
  return Math.min(used / limit, 1);
};

const contextTone = (fraction: number) =>
  fraction >= 0.85
    ? "bg-red-500"
    : fraction >= 0.6
      ? "bg-amber-500"
      : "bg-emerald-500";

export function SessionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const hideSubagents = searchParams.get("hide_subagents") !== "false";
  const forever = searchParams.get("forever") === "true";

  // Detect if any advanced filter is active to default collapsible open
  const hasAdvancedFilter = !!(
    searchParams.get("project") ||
    searchParams.get("tools") ||
    searchParams.get("files_read") ||
    searchParams.get("files_written") ||
    forever ||
    searchParams.get("include_empty") === "true"
  );
  const [advancedOpen, setAdvancedOpen] = useState(hasAdvancedFilter);

  const filters: SessionQueryParams = {
    search: searchParams.get("search") || undefined,
    machine: searchParams.get("machine") || undefined,
    days: forever ? undefined : (searchParams.get("days") ? parseInt(searchParams.get("days")!) : 30),
    forever: forever ? "true" : undefined,
    project: searchParams.get("project") || undefined,
    tools: searchParams.get("tools") || undefined,
    files_read: searchParams.get("files_read") || undefined,
    files_written: searchParams.get("files_written") || undefined,
    include_empty: searchParams.get("include_empty") === "true" ? "true" : undefined,
    limit: 50,
    min_user_messages: hideSubagents ? 2 : undefined,
  };

  const { data: sessions, isLoading, refetch } = useQuery({
    queryKey: ["sessions", filters],
    queryFn: () => sessionsApi.getSessions(filters),
    // Keeps both the activity ordering and the last-hour highlight from going stale
    refetchInterval: 60_000,
  });

  const { data: machines } = useQuery({
    queryKey: ["machines"],
    queryFn: sessionsApi.getMachines,
  });

  const { data: outlineProgress } = useQuery({
    queryKey: ["outline-progress"],
    queryFn: sessionsApi.getOutlineProgress,
    refetchInterval: 2000,
  });

  const syncMutation = useMutation({
    mutationFn: sessionsApi.triggerSync,
    onSuccess: () => {
      toast.success("Sync started");
      refetch();
    },
    onError: (error) => {
      toast.error(`Sync failed: ${error.message}`);
    },
  });

  const outlineMutation = useMutation({
    mutationFn: () => sessionsApi.triggerOutlines(),
    onSuccess: () => {
      toast.success("Outline generation started");
    },
    onError: (error) => {
      toast.error(`Failed: ${error.message}`);
    },
  });

  const updateFilter = (key: string, value: string | null) => {
    const newParams = new URLSearchParams(searchParams);
    if (value) {
      newParams.set(key, value);
    } else {
      newParams.delete(key);
    }
    setSearchParams(newParams);
  };

  const formatTokens = (tokens: number) => {
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
    return tokens.toString();
  };

  // Search results come back relevance-ordered, so the recent rows are only
  // contiguous — and only worth a divider — in the default activity ordering.
  const now = Date.now();
  const activityOrdered = !filters.search;
  const recentCount = (sessions ?? []).filter(
    (s) => now - lastActivityAt(s) < HOUR_MS
  ).length;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Sessions</h1>
          <p className="text-muted-foreground">
            Browse Claude Code session transcripts
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/sessions/activity">
              <Activity className="mr-2 h-4 w-4" />
              Activity
            </Link>
          </Button>
          <Button
            variant="outline"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || outlineProgress?.inProgress}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {syncMutation.isPending ? "Syncing..." : "Sync"}
          </Button>
          <Button
            onClick={() => outlineMutation.mutate()}
            disabled={outlineMutation.isPending || outlineProgress?.inProgress}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            {outlineMutation.isPending ? "Starting..." : "Generate Outlines"}
          </Button>
        </div>
      </div>

      {/* Outline Progress */}
      {outlineProgress?.inProgress && (
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">
                Synchronizing new/updated sessions on localhost...
              </span>
              <span className="text-sm text-muted-foreground">
                {outlineProgress.completed} / {outlineProgress.total}
              </span>
            </div>
            <Progress
              value={(outlineProgress.completed / outlineProgress.total) * 100}
            />
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="py-4 space-y-4">
          {/* Basic filters row */}
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-[200px]">
              <Input
                placeholder="Search sessions..."
                defaultValue={filters.search}
                onChange={(e) => updateFilter("search", e.target.value || null)}
              />
            </div>
            <Select
              value={filters.machine || "all"}
              onValueChange={(v) =>
                updateFilter("machine", v === "all" ? null : v)
              }
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All machines" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All machines</SelectItem>
                {machines?.map((machine) => (
                  <SelectItem key={machine.id} value={machine.machine_id}>
                    {machine.machine_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={forever ? "forever" : String(filters.days ?? 30)}
              onValueChange={(v) => {
                if (v === "forever") {
                  const p = new URLSearchParams(searchParams);
                  p.set("forever", "true");
                  p.delete("days");
                  setSearchParams(p);
                } else {
                  const p = new URLSearchParams(searchParams);
                  p.set("days", v);
                  p.delete("forever");
                  setSearchParams(p);
                }
              }}
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Time range" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
                <SelectItem value="365">Last year</SelectItem>
                <SelectItem value="forever">All time</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <Checkbox
                id="hide-subagents"
                checked={hideSubagents}
                onCheckedChange={(checked) =>
                  updateFilter("hide_subagents", checked ? null : "false")
                }
              />
              <label htmlFor="hide-subagents" className="text-sm cursor-pointer select-none">
                Hide subagents
              </label>
            </div>
          </div>

          {/* Advanced filters collapsible */}
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <button className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors select-none">
                {advancedOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                Advanced filters
                {hasAdvancedFilter && (
                  <span className="ml-1 rounded-full bg-primary w-1.5 h-1.5 inline-block" />
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="flex flex-wrap gap-4 pt-3">
                <div className="flex-1 min-w-[200px]">
                  <label className="text-xs text-muted-foreground mb-1 block">Project path</label>
                  <Input
                    placeholder="Substring match, e.g. my-project"
                    defaultValue={searchParams.get("project") || ""}
                    onChange={(e) => updateFilter("project", e.target.value || null)}
                  />
                </div>
                <div className="flex-1 min-w-[200px]">
                  <label className="text-xs text-muted-foreground mb-1 block">Tools used</label>
                  <Input
                    placeholder="Bash, Read, Edit, …"
                    defaultValue={searchParams.get("tools") || ""}
                    onChange={(e) => updateFilter("tools", e.target.value || null)}
                  />
                </div>
                <div className="flex-1 min-w-[200px]">
                  <label className="text-xs text-muted-foreground mb-1 block">Files read</label>
                  <Input
                    placeholder="Comma-separated paths"
                    defaultValue={searchParams.get("files_read") || ""}
                    onChange={(e) => updateFilter("files_read", e.target.value || null)}
                  />
                </div>
                <div className="flex-1 min-w-[200px]">
                  <label className="text-xs text-muted-foreground mb-1 block">Files written</label>
                  <Input
                    placeholder="Comma-separated paths"
                    defaultValue={searchParams.get("files_written") || ""}
                    onChange={(e) => updateFilter("files_written", e.target.value || null)}
                  />
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="include-empty"
                      checked={searchParams.get("include_empty") === "true"}
                      onCheckedChange={(checked) =>
                        updateFilter("include_empty", checked ? "true" : null)
                      }
                    />
                    <label htmlFor="include-empty" className="text-sm cursor-pointer select-none">
                      Include empty sessions
                    </label>
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      {/* Session List */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : sessions?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Started</TableHead>
                  <TableHead className="w-[100px]">Last activity</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead className="w-[150px]">Branch</TableHead>
                  <TableHead className="w-[130px]">Context</TableHead>
                  <TableHead className="w-[140px]">Size</TableHead>
                  <TableHead className="w-[180px]">ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session, i) => {
                  const elapsed = now - lastActivityAt(session);
                  const isRecent = elapsed < HOUR_MS;
                  // Closes the last-hour block off from everything older
                  const endsRecentBlock =
                    activityOrdered &&
                    isRecent &&
                    i === recentCount - 1 &&
                    recentCount < sessions.length;

                  return (
                  <TableRow
                    key={session.id}
                    className={[
                      isRecent ? "bg-emerald-50/70 dark:bg-emerald-950/40" : "",
                      endsRecentBlock ? "border-b-2 border-b-emerald-400" : "",
                    ].filter(Boolean).join(" ")}
                  >
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(session.started_at).toLocaleDateString()}{" "}
                      {new Date(session.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {isRecent ? (
                        <span
                          className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-200"
                          title={new Date(session.ended_at ?? session.started_at).toLocaleString()}
                        >
                          <span className="relative flex h-2 w-2 shrink-0">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                          </span>
                          {formatSinceActivity(elapsed)}
                        </span>
                      ) : session.ended_at ? (
                        <span title={new Date(session.ended_at).toLocaleString()}>
                          {new Date(session.ended_at).toLocaleDateString()}{" "}
                          {new Date(session.ended_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="max-w-0">
                      <Link
                        to={`/sessions/${session.id}`}
                        title={
                          session.title ||
                          session.project_path?.split("/").pop() ||
                          "Unknown"
                        }
                        className="hover:underline font-medium truncate block"
                      >
                        {session.title ||
                          session.project_path?.split("/").pop() ||
                          "Unknown"}
                      </Link>
                      <span
                        className="text-xs text-muted-foreground truncate block"
                        title={`${session.machine}:${session.project_path}`}
                      >
                        {session.machine}:{session.project_path}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      <span
                        className="block max-w-[150px] truncate"
                        title={session.git_branch || ""}
                      >
                        {session.git_branch || "N/A"}
                      </span>
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const fraction = contextFraction(session);
                        if (fraction === null) {
                          return <span className="text-xs text-muted-foreground">—</span>;
                        }
                        return (
                          <div
                            className="flex items-center gap-2"
                            title={`${session.context_final_tokens!.toLocaleString()} / ${session.context_limit_tokens!.toLocaleString()} tokens${
                              session.context_model ? ` · ${session.context_model}` : ""
                            }`}
                          >
                            <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                              <div
                                className={`h-full rounded-full ${contextTone(fraction)}`}
                                style={{ width: `${Math.max(fraction * 100, 2)}%` }}
                              />
                            </div>
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {Math.round(fraction * 100)}%
                            </span>
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="text-sm font-mono">
                      {session.message_count} / {formatTokens(session.input_tokens + session.output_tokens)}
                    </TableCell>
                    <TableCell>
                      <button
                        className="text-xs font-mono text-muted-foreground hover:text-foreground cursor-pointer truncate max-w-[170px] block text-left"
                        title={session.session_name || session.id}
                        onClick={() => {
                          const value = session.session_name || session.id;
                          navigator.clipboard.writeText(value);
                          toast.success(session.session_name ? "Session name copied" : "Session ID copied");
                        }}
                      >
                        {session.session_name || session.id.slice(0, 8)}
                      </button>
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="flex flex-col items-center justify-center py-12">
              <ScrollText className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No sessions found</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
