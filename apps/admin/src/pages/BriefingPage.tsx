import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { CalendarClock, Trash2, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { briefingApi } from "@/api/briefing";
import type { OverrideAction, SeriesOverride } from "@/types/api";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtTime(dt: string | null): string {
  if (!dt) return "—";
  const d = new Date(dt);
  return isNaN(d.getTime()) ? dt : d.toLocaleString();
}

interface EditorState {
  seriesId: string;
  action: OverrideAction;
  leadMinutes: string;
  note: string;
}

export function BriefingPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const date = searchParams.get("date") || todayIso();
  const [editor, setEditor] = useState<EditorState | null>(null);

  const setDate = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("date", value);
    else next.delete("date");
    setSearchParams(next);
  };

  const { data: plan, isLoading } = useQuery({
    queryKey: ["alert-plan", date],
    queryFn: () => briefingApi.getAlertPlan(date),
    refetchInterval: 60000,
  });

  const { data: overrides, isLoading: ovLoading } = useQuery({
    queryKey: ["briefing-overrides"],
    queryFn: briefingApi.listOverrides,
  });

  const saveMutation = useMutation({
    mutationFn: (e: EditorState) =>
      briefingApi.upsertOverride(e.seriesId, {
        action: e.action,
        leadMinutes: e.leadMinutes.trim() === "" ? null : parseInt(e.leadMinutes, 10),
        note: e.note.trim() === "" ? null : e.note.trim(),
      }),
    onSuccess: () => {
      toast.success("Override saved");
      setEditor(null);
      queryClient.invalidateQueries({ queryKey: ["briefing-overrides"] });
      queryClient.invalidateQueries({ queryKey: ["alert-plan"] });
    },
    onError: (error) => toast.error(`Save failed: ${error.message}`),
  });

  const removeMutation = useMutation({
    mutationFn: (seriesId: string) => briefingApi.removeOverride(seriesId),
    onSuccess: () => {
      toast.success("Override cleared");
      queryClient.invalidateQueries({ queryKey: ["briefing-overrides"] });
      queryClient.invalidateQueries({ queryKey: ["alert-plan"] });
    },
    onError: (error) => toast.error(`Clear failed: ${error.message}`),
  });

  const openEditor = (seriesId: string, existing?: SeriesOverride) => {
    setEditor({
      seriesId,
      action: existing?.action ?? "force",
      leadMinutes: existing?.leadMinutes != null ? String(existing.leadMinutes) : "",
      note: existing?.note ?? "",
    });
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Briefing Alerts</h1>
          <p className="text-muted-foreground">
            Resolved meeting-alert plan and per-series suppress/force overrides
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="plan-date" className="text-xs">
              Date
            </Label>
            <Input
              id="plan-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-9 w-[160px]"
            />
          </div>
        </div>
      </div>

      {/* Alert plan */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4" /> Alert plan
            {plan?.calendarError && (
              <Badge variant="destructive" className="ml-1">
                calendar error
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {plan?.calendarError && (
            <div className="px-4 pb-2 text-sm text-destructive">{plan.calendarError}</div>
          )}
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : plan?.items.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[160px]">Start</TableHead>
                  <TableHead>Meeting</TableHead>
                  <TableHead className="w-[90px]">Join?</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="w-[150px]">Fire at</TableHead>
                  <TableHead className="w-[70px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.items.map((item) => (
                  <TableRow key={item.eventId}>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {fmtTime(item.start)}
                    </TableCell>
                    <TableCell className="max-w-[280px]">
                      <div className="font-medium truncate">{item.summary}</div>
                      {item.venue && (
                        <div className="text-xs text-muted-foreground truncate">{item.venue}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      {item.joinRequired ? (
                        <Badge variant="default">join</Badge>
                      ) : (
                        <Badge variant="outline">skip</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[240px]">
                      {item.reason}
                      <span className="ml-1 opacity-60">({item.source})</span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {item.fireAt ? fmtTime(item.fireAt) : "—"}
                      {item.leadMinutes != null && (
                        <span className="opacity-60"> · {item.leadMinutes}m</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {item.seriesId && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Override this series"
                          onClick={() =>
                            openEditor(
                              item.seriesId!,
                              overrides?.overrides.find((o) => o.seriesId === item.seriesId)
                            )
                          }
                        >
                          <SlidersHorizontal className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="py-8 text-center text-muted-foreground">
              No meetings on the plan for this date
            </div>
          )}
        </CardContent>
      </Card>

      {/* Overrides */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Series overrides</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {ovLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : overrides?.overrides.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Series ID</TableHead>
                  <TableHead className="w-[100px]">Action</TableHead>
                  <TableHead className="w-[100px]">Lead</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead className="w-[110px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overrides.overrides.map((o) => (
                  <TableRow key={o.seriesId}>
                    <TableCell className="font-mono text-xs max-w-[240px] truncate">
                      {o.seriesId}
                    </TableCell>
                    <TableCell>
                      <Badge variant={o.action === "suppress" ? "outline" : "default"}>
                        {o.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {o.leadMinutes != null ? `${o.leadMinutes}m` : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[240px] truncate">
                      {o.note || "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => openEditor(o.seriesId, o)}>
                          <SlidersHorizontal className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeMutation.mutate(o.seriesId)}
                          disabled={removeMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="py-8 text-center text-muted-foreground">No overrides set</div>
          )}
        </CardContent>
      </Card>

      {/* Override editor */}
      <Dialog open={!!editor} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Series override</DialogTitle>
            <DialogDescription className="font-mono text-xs break-all">
              {editor?.seriesId}
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <div className="space-y-4">
              <div className="space-y-1">
                <Label className="text-xs">Action</Label>
                <Select
                  value={editor.action}
                  onValueChange={(v) => setEditor({ ...editor, action: v as OverrideAction })}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="force">force (always alert)</SelectItem>
                    <SelectItem value="suppress">suppress (never alert)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Lead minutes (optional, 0–240)</Label>
                <Input
                  type="number"
                  min={0}
                  max={240}
                  value={editor.leadMinutes}
                  placeholder="default"
                  onChange={(e) => setEditor({ ...editor, leadMinutes: e.target.value })}
                  className="h-9"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Note (optional)</Label>
                <Input
                  value={editor.note}
                  onChange={(e) => setEditor({ ...editor, note: e.target.value })}
                  className="h-9"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(null)}>
              Cancel
            </Button>
            <Button
              disabled={!editor || saveMutation.isPending}
              onClick={() => editor && saveMutation.mutate(editor)}
            >
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
