import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Bell, Activity, AlertTriangle } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

import { notifyApi } from "@/api/notify";
import type {
  NotificationPriority,
  NotificationStatus,
  HeartbeatEntry,
} from "@/types/api";

const PRIORITY_VARIANT: Record<
  NotificationPriority,
  "default" | "secondary" | "destructive" | "outline"
> = {
  interrupt: "destructive",
  notice: "default",
  digest: "secondary",
};

const STATUS_VARIANT: Record<
  NotificationStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  sent: "secondary",
  pending: "outline",
  error: "destructive",
};

/** Best-effort parse of a Postgres interval string ("24 hours", "9 days") to ms. */
function intervalToMs(interval: string): number | null {
  if (!interval) return null;
  const units: Record<string, number> = {
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
  };
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week)s?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(interval)) !== null) {
    const value = m[1];
    const unit = m[2]?.toLowerCase();
    const scale = unit ? units[unit] : undefined;
    if (value && scale) {
      total += parseFloat(value) * scale;
      matched = true;
    }
  }
  return matched ? total : null;
}

function isStale(hb: HeartbeatEntry): boolean {
  if (!hb.last_success_at) return true;
  const ms = intervalToMs(String(hb.threshold_interval));
  if (ms == null) return false;
  return Date.now() - new Date(hb.last_success_at).getTime() > ms;
}

function fmt(dt: string | null): string {
  return dt ? new Date(dt).toLocaleString() : "never";
}

export function NotificationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const priority = (searchParams.get("priority") as NotificationPriority) || undefined;

  const setPriority = (p: NotificationPriority | null) => {
    const next = new URLSearchParams(searchParams);
    if (p === null) next.delete("priority");
    else next.set("priority", p);
    setSearchParams(next);
  };

  const { data: notifications, isLoading } = useQuery({
    queryKey: ["notifications", priority ?? "all"],
    queryFn: () => notifyApi.listNotifications({ priority, limit: 200 }),
    refetchInterval: 15000,
  });

  const { data: heartbeats, isLoading: hbLoading } = useQuery({
    queryKey: ["heartbeats"],
    queryFn: notifyApi.listHeartbeats,
    refetchInterval: 30000,
  });

  const staleCount = heartbeats?.heartbeats.filter(isStale).length ?? 0;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Notifications &amp; Heartbeats</h1>
        <p className="text-muted-foreground">
          Recent dispatch log (redacted as stored) and the pipeline coverage board
        </p>
      </div>

      {/* Heartbeat board */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" /> Heartbeats
            {staleCount > 0 && (
              <Badge variant="destructive" className="ml-1">
                {staleCount} stale
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {hbLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : heartbeats?.heartbeats.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pipeline</TableHead>
                  <TableHead className="w-[190px]">Last beat</TableHead>
                  <TableHead className="w-[130px]">Threshold</TableHead>
                  <TableHead className="w-[110px]">Source</TableHead>
                  <TableHead className="w-[90px]">State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {heartbeats.heartbeats.map((hb) => {
                  const stale = isStale(hb);
                  return (
                    <TableRow key={hb.name} className={stale ? "bg-destructive/10" : ""}>
                      <TableCell className="font-medium">{hb.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {fmt(hb.last_success_at)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {String(hb.threshold_interval)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{hb.source}</TableCell>
                      <TableCell>
                        {stale ? (
                          <Badge variant="destructive" className="gap-1">
                            <AlertTriangle className="h-3 w-3" /> stale
                          </Badge>
                        ) : (
                          <Badge variant="secondary">ok</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="py-8 text-center text-muted-foreground">No heartbeats registered</div>
          )}
        </CardContent>
      </Card>

      {/* Notification log */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={!priority ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setPriority(null)}
        >
          All
        </Button>
        {(["interrupt", "notice", "digest"] as NotificationPriority[]).map((p) => (
          <Button
            key={p}
            variant={priority === p ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setPriority(p)}
          >
            {p}
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
          ) : notifications?.notifications.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[170px]">Time</TableHead>
                  <TableHead className="w-[100px]">Priority</TableHead>
                  <TableHead>Title / Body</TableHead>
                  <TableHead className="w-[130px]">Delivered</TableHead>
                  <TableHead className="w-[90px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {notifications.notifications.map((n) => (
                  <TableRow key={n.id}>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {fmt(n.ts)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={PRIORITY_VARIANT[n.priority]}>{n.priority}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[460px]">
                      <div className="font-medium truncate">{n.title}</div>
                      <div className="text-xs text-muted-foreground truncate">{n.body}</div>
                      {n.error && (
                        <div className="text-xs text-destructive truncate">{n.error}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {n.delivered_via.length ? n.delivered_via.join(", ") : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[n.status]}>{n.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="flex flex-col items-center justify-center py-12">
              <Bell className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No notifications logged</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
