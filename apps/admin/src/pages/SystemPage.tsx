import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Server, Clock, Play, CheckCircle, XCircle, Monitor } from "lucide-react";
import { toast } from "sonner";

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

import { systemApi } from "@/api/system";
import { sessionsApi } from "@/api/sessions";

export function SystemPage() {
  const queryClient = useQueryClient();

  const { data: health, isLoading: healthLoading } = useQuery({
    queryKey: ["health"],
    queryFn: systemApi.getHealth,
    refetchInterval: 10000,
  });

  const { data: tasks, isLoading: tasksLoading } = useQuery({
    queryKey: ["scheduler-tasks"],
    queryFn: systemApi.getTasks,
    refetchInterval: 30000,
  });

  const { data: machines, isLoading: machinesLoading } = useQuery({
    queryKey: ["machines"],
    queryFn: sessionsApi.getMachines,
  });

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

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">System</h1>
        <p className="text-muted-foreground">
          Monitor system health and manage scheduled tasks
        </p>
      </div>

      {/* Health Status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Server className="h-5 w-5" />
            System Health
          </CardTitle>
        </CardHeader>
        <CardContent>
          {healthLoading ? (
            <Skeleton className="h-12 w-48" />
          ) : (
            <div className="flex items-center gap-4">
              {health?.status === "ok" ? (
                <>
                  <CheckCircle className="h-8 w-8 text-green-500" />
                  <div>
                    <p className="font-medium text-lg">System Healthy</p>
                    <p className="text-sm text-muted-foreground">
                      All services operational
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <XCircle className="h-8 w-8 text-red-500" />
                  <div>
                    <p className="font-medium text-lg text-red-600">
                      System Error
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Check server logs for details
                    </p>
                  </div>
                </>
              )}
              {health?.timestamp && (
                <Badge variant="outline" className="ml-auto">
                  Last check: {new Date(health.timestamp).toLocaleTimeString()}
                </Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Scheduled Tasks */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Scheduled Tasks
          </CardTitle>
        </CardHeader>
        <CardContent>
          {tasksLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : tasks?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task Name</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Next Run</TableHead>
                  <TableHead className="w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => (
                  <TableRow key={task.name}>
                    <TableCell className="font-medium">{task.name}</TableCell>
                    <TableCell>
                      <code className="text-xs bg-muted px-2 py-1 rounded">
                        {task.schedule}
                      </code>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {task.nextRun
                        ? new Date(task.nextRun).toLocaleString()
                        : "Not scheduled"}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => triggerTaskMutation.mutate(task.name)}
                        disabled={triggerTaskMutation.isPending}
                      >
                        <Play className="h-4 w-4 mr-1" />
                        Run
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No scheduled tasks configured
            </p>
          )}
        </CardContent>
      </Card>

      {/* Machine Inventory */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Monitor className="h-5 w-5" />
            Machine Inventory
          </CardTitle>
        </CardHeader>
        <CardContent>
          {machinesLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : machines?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Machine ID</TableHead>
                  <TableHead>Hostname</TableHead>
                  <TableHead>Sessions</TableHead>
                  <TableHead>First Seen</TableHead>
                  <TableHead>Last Sync</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {machines.map((machine) => (
                  <TableRow key={machine.id}>
                    <TableCell className="font-mono text-sm">
                      {machine.machine_id}
                      {machine.is_localhost && (
                        <Badge variant="secondary" className="ml-2 text-xs">
                          localhost
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{machine.hostname || "Unknown"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{machine.session_count}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(machine.first_seen_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {machine.last_sync_at
                        ? new Date(machine.last_sync_at).toLocaleString()
                        : "Never"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No machines registered
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
