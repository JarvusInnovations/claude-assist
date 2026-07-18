import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Inbox, Link2, ExternalLink } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { captureApi } from "@/api/capture";
import type { CaptureRecord, CaptureStatus, CaptureType } from "@/types/api";

const STATUSES: CaptureStatus[] = [
  "queued",
  "classified",
  "awaiting_review",
  "awaiting_executor",
  "routed",
  "resolved",
];

const CAPTURE_TYPES: CaptureType[] = [
  "stray_thought",
  "link_reference",
  "actionable",
  "team_relevant",
];

const STATUS_VARIANT: Record<
  CaptureStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  queued: "secondary",
  classified: "default",
  awaiting_review: "outline",
  awaiting_executor: "outline",
  routed: "secondary",
  resolved: "secondary",
};

function fmt(dt: string | null): string {
  return dt ? new Date(dt).toLocaleString() : "—";
}

export function CapturesPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [detailUlid, setDetailUlid] = useState<string | null>(null);

  const view = searchParams.get("view") || "queue";
  const status = (searchParams.get("status") as CaptureStatus) || undefined;

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setSearchParams(next);
  };

  const { data: queue, isLoading } = useQuery({
    queryKey: ["captures", status ?? "all"],
    queryFn: () => captureApi.list({ status, limit: 200 }),
    refetchInterval: 15000,
    enabled: view === "queue",
  });

  const { data: references, isLoading: refsLoading } = useQuery({
    queryKey: ["capture-references"],
    queryFn: () => captureApi.listReferences({ limit: 200 }),
    enabled: view === "references",
  });

  const { data: detail } = useQuery({
    queryKey: ["capture", detailUlid],
    queryFn: () => captureApi.get(detailUlid!),
    enabled: !!detailUlid,
  });

  const correctMutation = useMutation({
    mutationFn: ({ ulid, type }: { ulid: string; type: CaptureType }) =>
      captureApi.correct(ulid, type),
    onSuccess: (updated) => {
      toast.success(`Re-routed as ${updated.classification?.type ?? "corrected"}`);
      queryClient.invalidateQueries({ queryKey: ["captures"] });
      queryClient.invalidateQueries({ queryKey: ["capture", updated.ulid] });
      queryClient.invalidateQueries({ queryKey: ["capture-references"] });
    },
    onError: (error) => toast.error(`Correction failed: ${error.message}`),
  });

  const captures = queue?.captures ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Captures</h1>
          <p className="text-muted-foreground">
            The capture queue, classification, and routed link references
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={view === "queue" ? "default" : "outline"}
            size="sm"
            onClick={() => setParam("view", "queue")}
          >
            <Inbox className="h-4 w-4 mr-1" /> Queue
          </Button>
          <Button
            variant={view === "references" ? "default" : "outline"}
            size="sm"
            onClick={() => setParam("view", "references")}
          >
            <Link2 className="h-4 w-4 mr-1" /> References
          </Button>
        </div>
      </div>

      {view === "queue" && (
        <>
          {/* Status filter chips */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={!status ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setParam("status", null)}
            >
              All
            </Button>
            {STATUSES.map((s) => (
              <Button
                key={s}
                variant={status === s ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setParam("status", s)}
              >
                {s}
              </Button>
            ))}
          </div>

          <Card>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-4 space-y-2">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : captures.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[150px]">Captured</TableHead>
                      <TableHead className="w-[110px]">Status</TableHead>
                      <TableHead className="w-[130px]">Type</TableHead>
                      <TableHead>Text</TableHead>
                      <TableHead className="w-[90px]">Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {captures.map((c) => (
                      <TableRow
                        key={c.ulid}
                        className="cursor-pointer"
                        onClick={() => setDetailUlid(c.ulid)}
                      >
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {fmt(c.captured_at)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[c.status]}>{c.status}</Badge>
                        </TableCell>
                        <TableCell className="text-sm">
                          {c.classification?.type ?? c.type_hint ?? "—"}
                        </TableCell>
                        <TableCell className="max-w-[420px] truncate">
                          {c.classification?.title || c.text}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {c.source}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="flex flex-col items-center justify-center py-12">
                  <Inbox className="h-12 w-12 text-muted-foreground mb-4" />
                  <p className="text-muted-foreground">No captures{status ? ` in ${status}` : ""}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {view === "references" && (
        <Card>
          <CardContent className="p-0">
            {refsLoading ? (
              <div className="p-4 space-y-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : references?.references.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[150px]">Captured</TableHead>
                    <TableHead>Title / URL</TableHead>
                    <TableHead className="w-[140px]">Site</TableHead>
                    <TableHead className="w-[60px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {references.references.map((r) => (
                    <TableRow key={r.capture_ulid}>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {fmt(r.captured_at)}
                      </TableCell>
                      <TableCell className="max-w-[480px]">
                        <div className="font-medium truncate">{r.title || r.url}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {r.final_url || r.url}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.site_name || "—"}
                      </TableCell>
                      <TableCell>
                        <a
                          href={r.final_url || r.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="flex flex-col items-center justify-center py-12">
                <Link2 className="h-12 w-12 text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No references stored yet</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Detail dialog with one-click correction */}
      <Dialog open={!!detailUlid} onOpenChange={(open) => !open && setDetailUlid(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Capture detail</DialogTitle>
            <DialogDescription className="font-mono text-xs">{detailUlid}</DialogDescription>
          </DialogHeader>
          {detail ? (
            <CaptureDetail
              capture={detail}
              onCorrect={(type) => correctMutation.mutate({ ulid: detail.ulid, type })}
              correcting={correctMutation.isPending}
            />
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CaptureDetail({
  capture,
  onCorrect,
  correcting,
}: {
  capture: CaptureRecord;
  onCorrect: (type: CaptureType) => void;
  correcting: boolean;
}) {
  const [pick, setPick] = useState<CaptureType | "">("");
  const canCorrect = capture.status !== "queued";

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap gap-2">
        <Badge variant={STATUS_VARIANT[capture.status]}>{capture.status}</Badge>
        {capture.classification && (
          <Badge variant="outline">
            {capture.classification.type} · {(capture.classification.confidence * 100).toFixed(0)}%
            · {capture.classification.classifier}
          </Badge>
        )}
        {capture.route_destination && (
          <Badge variant="secondary">→ {capture.route_destination}</Badge>
        )}
      </div>

      <div className="rounded-md border p-3 whitespace-pre-wrap">{capture.text}</div>

      {capture.classification?.rationale && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Rationale</div>
          <div className="text-muted-foreground">{capture.classification.rationale}</div>
        </div>
      )}

      {capture.urls.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">URLs</div>
          <ul className="space-y-0.5">
            {capture.urls.map((u) => (
              <li key={u}>
                <a href={u} target="_blank" rel="noreferrer" className="hover:underline break-all">
                  {u}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div>Captured: {fmt(capture.captured_at)}</div>
        <div>Received: {fmt(capture.received_at)}</div>
        <div>Classified: {fmt(capture.classified_at)}</div>
        <div>Routed: {fmt(capture.routed_at)}</div>
        <div>Classify attempts: {capture.classify_attempts}</div>
        <div>Route attempts: {capture.route_attempts}</div>
      </dl>

      {capture.last_error && (
        <div className="text-xs text-destructive">Last error: {capture.last_error}</div>
      )}

      <div className="flex items-center gap-2 border-t pt-4">
        <span className="text-xs font-medium text-muted-foreground">Correct type:</span>
        <Select value={pick} onValueChange={(v) => setPick(v as CaptureType)}>
          <SelectTrigger className="w-[180px] h-8">
            <SelectValue placeholder="Pick type…" />
          </SelectTrigger>
          <SelectContent>
            {CAPTURE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={!pick || !canCorrect || correcting}
          onClick={() => pick && onCorrect(pick)}
        >
          {correcting ? "Applying…" : "Re-route"}
        </Button>
        {!canCorrect && (
          <span className="text-xs text-muted-foreground">Not yet classified</span>
        )}
      </div>
    </div>
  );
}
