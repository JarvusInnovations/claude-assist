import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams, Link } from "react-router";
import { Tags, FileText } from "lucide-react";

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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

import { classificationApi } from "@/api/classification";
import type { ClassificationEventType, SynthesisReport } from "@/types/api";

const EVENT_TYPES: ClassificationEventType[] = [
  "correction",
  "friction",
  "rule-candidate",
  "notable-decision",
];

const TYPE_VARIANT: Record<
  ClassificationEventType,
  "default" | "secondary" | "destructive" | "outline"
> = {
  correction: "destructive",
  friction: "default",
  "rule-candidate": "secondary",
  "notable-decision": "outline",
};

function fmt(dt: string): string {
  const d = new Date(dt);
  return isNaN(d.getTime()) ? dt : d.toLocaleString();
}

export function ClassificationPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("view") === "reports" ? "reports" : "events";
  const type = (searchParams.get("type") as ClassificationEventType) || undefined;
  const [reader, setReader] = useState<SynthesisReport | null>(null);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setSearchParams(next);
  };

  const { data: events, isLoading: evLoading } = useQuery({
    queryKey: ["classification-events", type ?? "all"],
    queryFn: () => classificationApi.listEvents({ type, days: 30, limit: 300 }),
    enabled: view === "events",
  });

  const { data: reports, isLoading: rpLoading } = useQuery({
    queryKey: ["classification-reports"],
    queryFn: () => classificationApi.listReports(50),
    enabled: view === "reports",
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Session Classification</h1>
          <p className="text-muted-foreground">
            Detected events across sessions and the weekly synthesis / narrative reports
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={view === "events" ? "default" : "outline"}
            size="sm"
            onClick={() => setParam("view", "events")}
          >
            <Tags className="h-4 w-4 mr-1" /> Events
          </Button>
          <Button
            variant={view === "reports" ? "default" : "outline"}
            size="sm"
            onClick={() => setParam("view", "reports")}
          >
            <FileText className="h-4 w-4 mr-1" /> Reports
          </Button>
        </div>
      </div>

      {view === "events" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={!type ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setParam("type", null)}
            >
              All
            </Button>
            {EVENT_TYPES.map((t) => (
              <Button
                key={t}
                variant={type === t ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setParam("type", t)}
              >
                {t}
              </Button>
            ))}
          </div>

          <Card>
            <CardContent className="p-0">
              {evLoading ? (
                <div className="p-4 space-y-2">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : events?.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[160px]">When</TableHead>
                      <TableHead className="w-[130px]">Type</TableHead>
                      <TableHead>Summary</TableHead>
                      <TableHead className="w-[200px]">Session</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {fmt(e.created_at)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={TYPE_VARIANT[e.event_type]}>{e.event_type}</Badge>
                        </TableCell>
                        <TableCell className="max-w-[420px]">
                          <div className="truncate">{e.summary}</div>
                          {e.quote && (
                            <div className="text-xs text-muted-foreground truncate italic">
                              “{e.quote}”
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          <Link
                            to={`/sessions/${e.session_id}`}
                            className="hover:underline truncate block max-w-[190px]"
                          >
                            {e.title || e.project_path || e.session_id}
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="flex flex-col items-center justify-center py-12">
                  <Tags className="h-12 w-12 text-muted-foreground mb-4" />
                  <p className="text-muted-foreground">No classification events</p>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {view === "reports" && (
        <Card>
          <CardContent className="p-0">
            {rpLoading ? (
              <div className="p-4 space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : reports?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[130px]">Kind</TableHead>
                    <TableHead className="w-[240px]">Period</TableHead>
                    <TableHead className="w-[100px]">Events</TableHead>
                    <TableHead className="w-[170px]">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reports.map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer"
                      onClick={() => setReader(r)}
                    >
                      <TableCell>
                        <Badge variant="secondary">{r.kind}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.period_start} → {r.period_end}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.event_count}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {fmt(r.created_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="flex flex-col items-center justify-center py-12">
                <FileText className="h-12 w-12 text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No synthesis reports yet</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Report reader */}
      <Dialog open={!!reader} onOpenChange={(open) => !open && setReader(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="capitalize">{reader?.kind} report</DialogTitle>
            <DialogDescription>
              {reader && `${reader.period_start} → ${reader.period_end} · ${reader.event_count} events`}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[65vh]">
            <pre className="whitespace-pre-wrap text-sm font-sans leading-relaxed pr-4">
              {reader?.report}
            </pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
