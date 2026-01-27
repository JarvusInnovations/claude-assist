import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Users, Mail, ScrollText, Clock, Play } from "lucide-react";
import { toast } from "sonner";

import { StatCard } from "@/components/StatCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

import { googleApi } from "@/api/google";
import { sessionsApi } from "@/api/sessions";
import { systemApi } from "@/api/system";

export function DashboardPage() {
  const queryClient = useQueryClient();

  // Fetch data
  const { data: accounts, isLoading: accountsLoading } = useQuery({
    queryKey: ["accounts"],
    queryFn: googleApi.getAccounts,
  });

  const { data: emailStats, isLoading: emailStatsLoading } = useQuery({
    queryKey: ["email-stats"],
    queryFn: () => googleApi.getEmailStats({ days: 7 }),
  });

  const { data: sessionStats, isLoading: sessionStatsLoading } = useQuery({
    queryKey: ["session-stats"],
    queryFn: () => sessionsApi.getStats({ days: 7 }),
  });

  const { data: tasks, isLoading: tasksLoading } = useQuery({
    queryKey: ["scheduler-tasks"],
    queryFn: systemApi.getTasks,
    refetchInterval: 30000, // Refresh every 30s
  });

  // Mutations
  const triggerTaskMutation = useMutation({
    mutationFn: systemApi.triggerTask,
    onSuccess: (_, taskName) => {
      toast.success(`Task "${taskName}" triggered`);
      queryClient.invalidateQueries({ queryKey: ["scheduler-tasks"] });
    },
    onError: (error, taskName) => {
      toast.error(`Failed to trigger "${taskName}": ${error.message}`);
    },
  });

  const triggerSyncMutation = useMutation({
    mutationFn: () => googleApi.triggerSync(),
    onSuccess: () => {
      toast.success("Email sync started");
    },
    onError: (error) => {
      toast.error(`Sync failed: ${error.message}`);
    },
  });

  const triggerTriageMutation = useMutation({
    mutationFn: () => googleApi.triggerTriage(),
    onSuccess: () => {
      toast.success("Email triage started");
    },
    onError: (error) => {
      toast.error(`Triage failed: ${error.message}`);
    },
  });

  // Calculate stats
  const pendingEmails =
    (emailStats?.byStatus?.discovered ?? 0) + (emailStats?.byStatus?.new ?? 0);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-muted-foreground">
          Overview of your Claude Assist system
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Google Accounts"
          value={accounts?.length ?? 0}
          description="Connected accounts"
          icon={Users}
          isLoading={accountsLoading}
        />
        <StatCard
          title="Pending Emails"
          value={pendingEmails}
          description="Awaiting triage"
          icon={Mail}
          isLoading={emailStatsLoading}
        />
        <StatCard
          title="Total Emails"
          value={emailStats?.total ?? 0}
          description="Last 7 days"
          icon={Mail}
          isLoading={emailStatsLoading}
        />
        <StatCard
          title="Sessions"
          value={sessionStats?.totalSessions ?? 0}
          description="Last 7 days"
          icon={ScrollText}
          isLoading={sessionStatsLoading}
        />
      </div>

      {/* Quick Actions & Scheduled Tasks */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => triggerSyncMutation.mutate()}
              disabled={triggerSyncMutation.isPending}
            >
              <Mail className="mr-2 h-4 w-4" />
              {triggerSyncMutation.isPending ? "Syncing..." : "Sync Emails"}
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => triggerTriageMutation.mutate()}
              disabled={triggerTriageMutation.isPending}
            >
              <Play className="mr-2 h-4 w-4" />
              {triggerTriageMutation.isPending ? "Starting..." : "Triage Pending"}
            </Button>
          </CardContent>
        </Card>

        {/* Scheduled Tasks */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Scheduled Tasks</CardTitle>
          </CardHeader>
          <CardContent>
            {tasksLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : tasks?.length ? (
              <div className="space-y-2">
                {tasks.map((task) => (
                  <div
                    key={task.name}
                    className="flex items-center justify-between p-2 rounded-md border"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">
                        {task.name}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {task.nextRun
                          ? new Date(task.nextRun).toLocaleString()
                          : "Not scheduled"}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => triggerTaskMutation.mutate(task.name)}
                      disabled={triggerTaskMutation.isPending}
                    >
                      <Play className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No scheduled tasks</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Email Stats Breakdown */}
      {emailStats && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Email Statistics (7 days)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <h4 className="font-medium text-sm mb-2">By Status</h4>
                <div className="space-y-1">
                  {Object.entries(emailStats.byStatus || {}).map(
                    ([status, count]) => (
                      <div
                        key={status}
                        className="flex justify-between text-sm"
                      >
                        <Badge variant="outline">{status}</Badge>
                        <span>{count as number}</span>
                      </div>
                    )
                  )}
                </div>
              </div>
              <div>
                <h4 className="font-medium text-sm mb-2">By Message Type</h4>
                <div className="space-y-1">
                  {Object.entries(emailStats.byMessageType || {}).map(
                    ([type, count]) => (
                      <div key={type} className="flex justify-between text-sm">
                        <Badge variant="secondary">{type}</Badge>
                        <span>{count as number}</span>
                      </div>
                    )
                  )}
                </div>
              </div>
              <div>
                <h4 className="font-medium text-sm mb-2">By Sender Type</h4>
                <div className="space-y-1">
                  {Object.entries(emailStats.bySenderType || {}).map(
                    ([type, count]) => (
                      <div key={type} className="flex justify-between text-sm">
                        <Badge variant="secondary">{type}</Badge>
                        <span>{count as number}</span>
                      </div>
                    )
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
