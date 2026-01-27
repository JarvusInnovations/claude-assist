import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { ScrollText, RefreshCw, Sparkles, Search } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { sessionsApi } from "@/api/sessions";
import type { SessionQueryParams } from "@/types/api";

export function SessionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters: SessionQueryParams = {
    search: searchParams.get("search") || undefined,
    machine: searchParams.get("machine") || undefined,
    days: searchParams.get("days") ? parseInt(searchParams.get("days")!) : 30,
    limit: 50,
  };

  const { data: sessions, isLoading, refetch } = useQuery({
    queryKey: ["sessions", filters],
    queryFn: () => sessionsApi.getSessions(filters),
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
          <Button
            variant="outline"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {syncMutation.isPending ? "Syncing..." : "Sync"}
          </Button>
          <Button
            onClick={() => outlineMutation.mutate()}
            disabled={outlineMutation.isPending}
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
                Generating outlines...
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
        <CardContent className="py-4">
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
                    {machine.hostname || machine.machine_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={String(filters.days)}
              onValueChange={(v) => updateFilter("days", v)}
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Time range" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
                <SelectItem value="365">Last year</SelectItem>
              </SelectContent>
            </Select>
          </div>
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
                  <TableHead>Project</TableHead>
                  <TableHead className="w-[100px]">Branch</TableHead>
                  <TableHead className="w-[80px]">Messages</TableHead>
                  <TableHead className="w-[100px]">Tokens</TableHead>
                  <TableHead className="w-[80px]">Outline</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(session.started_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="max-w-0">
                      <Link
                        to={`/sessions/${session.id}`}
                        className="hover:underline font-medium truncate block"
                      >
                        {session.title ||
                          session.project_path?.split("/").pop() ||
                          "Unknown"}
                      </Link>
                      <span className="text-xs text-muted-foreground truncate block">
                        {session.project_path}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {session.git_branch || "N/A"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {session.message_count}
                    </TableCell>
                    <TableCell className="text-sm font-mono">
                      {formatTokens(
                        session.input_tokens + session.output_tokens
                      )}
                    </TableCell>
                    <TableCell>
                      {session.outline ? (
                        <Badge variant="outline">Yes</Badge>
                      ) : (
                        <Badge variant="secondary">No</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
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
