import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Zap, ExternalLink, ThumbsUp, ThumbsDown } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { urgencyApi } from "@/api/urgency";
import type { UrgencyCandidate } from "@/types/api";

function fmt(dt: string): string {
  const d = new Date(dt);
  return isNaN(d.getTime()) ? dt : d.toLocaleString();
}

export function UrgencyPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("view") === "near-misses" ? "near-misses" : "interrupts";

  const setView = (v: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("view", v);
    setSearchParams(next);
  };

  const { data: interrupts, isLoading: intLoading } = useQuery({
    queryKey: ["urgency-interrupts"],
    queryFn: () => urgencyApi.listInterrupts(100),
    refetchInterval: 20000,
    enabled: view === "interrupts",
  });

  const { data: nearMisses, isLoading: nmLoading } = useQuery({
    queryKey: ["urgency-near-misses"],
    queryFn: () => urgencyApi.listNearMisses(100),
    refetchInterval: 20000,
    enabled: view === "near-misses",
  });

  const correctMutation = useMutation({
    mutationFn: ({ id, verdict }: { id: string; verdict: "should_interrupt" | "should_not" }) =>
      urgencyApi.correct(id, verdict),
    onSuccess: (res) => {
      toast.success(
        `Corrected: ${res.corrected} · sender ${res.sender_weight.toFixed(2)} / channel ${res.channel_weight.toFixed(2)}`
      );
      queryClient.invalidateQueries({ queryKey: ["urgency-interrupts"] });
      queryClient.invalidateQueries({ queryKey: ["urgency-near-misses"] });
    },
    onError: (error) => toast.error(`Correction failed: ${error.message}`),
  });

  const rows = view === "interrupts" ? interrupts?.interrupts : nearMisses?.near_misses;
  const loading = view === "interrupts" ? intLoading : nmLoading;

  const correct = (c: UrgencyCandidate, verdict: "should_interrupt" | "should_not") =>
    correctMutation.mutate({ id: `${c.channel}-${c.ts}`, verdict });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Slack Urgency</h1>
          <p className="text-muted-foreground">
            Fired interrupts and near-misses, with one-click precision corrections
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={view === "interrupts" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("interrupts")}
          >
            <Zap className="h-4 w-4 mr-1" /> Interrupts
          </Button>
          <Button
            variant={view === "near-misses" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("near-misses")}
          >
            Near-misses
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : rows?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[160px]">When</TableHead>
                  <TableHead className="w-[150px]">From</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead className="w-[100px]">Tier</TableHead>
                  <TableHead className="w-[180px]">Correct</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={`${c.channel}-${c.ts}`}>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {fmt(c.message_ts)}
                    </TableCell>
                    <TableCell className="text-sm">
                      <div className="font-medium truncate max-w-[140px]">
                        {c.sender_name || c.sender}
                      </div>
                      <div className="text-xs text-muted-foreground truncate max-w-[140px]">
                        {c.channel_type}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[380px]">
                      <div className="truncate">{c.gist || c.text}</div>
                      <div className="mt-0.5 flex items-center gap-1">
                        <Badge variant={c.interrupted ? "destructive" : "outline"}>
                          {c.verdict}
                        </Badge>
                        {c.permalink && (
                          <a
                            href={c.permalink}
                            target="_blank"
                            rel="noreferrer"
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {c.tier}
                      {c.confidence != null && (
                        <span className="opacity-60"> · {(c.confidence * 100).toFixed(0)}%</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          title="Should have interrupted"
                          disabled={correctMutation.isPending}
                          onClick={() => correct(c, "should_interrupt")}
                        >
                          <ThumbsUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          title="Should not have interrupted"
                          disabled={correctMutation.isPending}
                          onClick={() => correct(c, "should_not")}
                        >
                          <ThumbsDown className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="flex flex-col items-center justify-center py-12">
              <Zap className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">
                No {view === "interrupts" ? "interrupts" : "near-misses"} recorded
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
