import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { Mail, RefreshCw, Play, Search, Filter } from "lucide-react";
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

import { googleApi } from "@/api/google";
import type { EmailQueryParams, WorkflowStatus, MessageType } from "@/types/api";

export function EmailsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters: EmailQueryParams = {
    workflow_status: (searchParams.get("status") as WorkflowStatus) || undefined,
    message_type: (searchParams.get("type") as MessageType) || undefined,
    search: searchParams.get("search") || undefined,
    account: searchParams.get("account") || undefined,
    limit: 50,
  };

  const { data: emails, isLoading, refetch } = useQuery({
    queryKey: ["emails", filters],
    queryFn: () => googleApi.getEmails(filters),
    refetchInterval: 10000,
  });

  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: googleApi.getAccounts,
  });

  const { data: triageProgress } = useQuery({
    queryKey: ["triage-progress"],
    queryFn: googleApi.getTriageProgress,
    refetchInterval: 2000,
  });

  const syncMutation = useMutation({
    mutationFn: () => googleApi.triggerSync(),
    onSuccess: () => {
      toast.success("Sync started");
    },
    onError: (error) => {
      toast.error(`Sync failed: ${error.message}`);
    },
  });

  const triageMutation = useMutation({
    mutationFn: () => googleApi.triggerTriage({ limit: 50 }),
    onSuccess: () => {
      toast.success("Triage started");
    },
    onError: (error) => {
      toast.error(`Triage failed: ${error.message}`);
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

  const getStatusBadge = (status: WorkflowStatus) => {
    switch (status) {
      case "discovered":
        return <Badge variant="secondary">Discovered</Badge>;
      case "new":
        return <Badge variant="default">New</Badge>;
      case "triaged":
        return <Badge variant="outline">Triaged</Badge>;
    }
  };

  const getTypeBadge = (type: MessageType | undefined) => {
    if (!type) return null;
    const colors: Record<MessageType, string> = {
      spam: "bg-red-100 text-red-800",
      newsletter: "bg-blue-100 text-blue-800",
      alert: "bg-yellow-100 text-yellow-800",
      group: "bg-purple-100 text-purple-800",
      personal: "bg-green-100 text-green-800",
    };
    return (
      <span className={`px-2 py-0.5 rounded text-xs ${colors[type]}`}>
        {type}
      </span>
    );
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Emails</h1>
          <p className="text-muted-foreground">Browse and manage synced emails</p>
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
            onClick={() => triageMutation.mutate()}
            disabled={triageMutation.isPending}
          >
            <Play className="mr-2 h-4 w-4" />
            {triageMutation.isPending ? "Starting..." : "Triage"}
          </Button>
        </div>
      </div>

      {/* Triage Progress */}
      {triageProgress?.inProgress && (
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Triage in progress</span>
              <span className="text-sm text-muted-foreground">
                {triageProgress.completed} / {triageProgress.total}
              </span>
            </div>
            <Progress
              value={(triageProgress.completed / triageProgress.total) * 100}
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
                placeholder="Search emails..."
                defaultValue={filters.search}
                onChange={(e) => updateFilter("search", e.target.value || null)}
              />
            </div>
            <Select
              value={filters.account || "all"}
              onValueChange={(v) => updateFilter("account", v === "all" ? null : v)}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All accounts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                {accounts?.map((account) => (
                  <SelectItem key={account.id} value={account.identifier}>
                    {account.identifier}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filters.workflow_status || "all"}
              onValueChange={(v) => updateFilter("status", v === "all" ? null : v)}
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="discovered">Discovered</SelectItem>
                <SelectItem value="new">New</SelectItem>
                <SelectItem value="triaged">Triaged</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={filters.message_type || "all"}
              onValueChange={(v) => updateFilter("type", v === "all" ? null : v)}
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="personal">Personal</SelectItem>
                <SelectItem value="newsletter">Newsletter</SelectItem>
                <SelectItem value="alert">Alert</SelectItem>
                <SelectItem value="group">Group</SelectItem>
                <SelectItem value="spam">Spam</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Email List */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : emails?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">Date</TableHead>
                  <TableHead className="w-[200px]">From</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead className="w-[100px]">Type</TableHead>
                  <TableHead className="w-[100px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {emails.map((email) => (
                  <TableRow key={email.id}>
                    <TableCell className="text-sm text-muted-foreground">
                      {email.date
                        ? new Date(email.date).toLocaleDateString()
                        : "N/A"}
                    </TableCell>
                    <TableCell className="font-medium truncate max-w-[200px]">
                      {email.from_name || email.from_address || "Unknown"}
                    </TableCell>
                    <TableCell>
                      <Link
                        to={`/emails/${email.id}`}
                        className="hover:underline truncate block"
                      >
                        {email.subject || "(No subject)"}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {getTypeBadge(email.analysis?.message_type)}
                    </TableCell>
                    <TableCell>{getStatusBadge(email.workflow_status)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="flex flex-col items-center justify-center py-12">
              <Mail className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No emails found</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
