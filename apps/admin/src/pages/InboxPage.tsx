import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { Mail, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { googleApi } from "@/api/google";
import type { MessageType } from "@/types/api";

const MESSAGE_TYPES: MessageType[] = ["personal", "alert", "newsletter", "spam", "group"];
const PAGE_SIZES = [50, 100, 250, 500];

const TAB_COLORS: Record<MessageType, string> = {
  spam: "bg-red-100 text-red-800",
  newsletter: "bg-blue-100 text-blue-800",
  alert: "bg-yellow-100 text-yellow-800",
  group: "bg-purple-100 text-purple-800",
  personal: "bg-green-100 text-green-800",
};

export function InboxPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // URL-derived state
  const activeTab = (searchParams.get("tab") as MessageType) || "personal";
  const pageSize = parseInt(searchParams.get("pageSize") || "50", 10);
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  // Fetch stats for tab badges
  const { data: stats } = useQuery({
    queryKey: ["email-stats", 30],
    queryFn: () => googleApi.getEmailStats({ days: 30 }),
  });

  // Fetch emails for current tab
  const { data: emails, isLoading } = useQuery({
    queryKey: ["inbox-emails", activeTab, pageSize, offset],
    queryFn: () =>
      googleApi.getEmails({
        message_type: activeTab,
        limit: pageSize,
        offset,
        days: 30,
      }),
    refetchInterval: 10000,
  });

  // Bulk action mutation
  const bulkMutation = useMutation({
    mutationFn: (action: string) =>
      googleApi.bulkAction({ emailIds: Array.from(selectedIds), action }),
    onSuccess: (result) => {
      if (result.success) {
        toast.success(result.message);
        setSelectedIds(new Set());
        queryClient.invalidateQueries({ queryKey: ["inbox-emails"] });
        queryClient.invalidateQueries({ queryKey: ["email-stats"] });
      } else {
        toast.error(result.error || "Action failed");
      }
    },
    onError: (error) => {
      toast.error(`Action failed: ${error.message}`);
    },
  });

  // Tab change handler
  const handleTabChange = (tab: string) => {
    const newParams = new URLSearchParams(searchParams);
    newParams.set("tab", tab);
    newParams.delete("offset"); // Reset to page 1
    setSearchParams(newParams);
    setSelectedIds(new Set()); // Clear selection
  };

  // Page size change handler
  const handlePageSizeChange = (size: string) => {
    const newParams = new URLSearchParams(searchParams);
    newParams.set("pageSize", size);
    newParams.delete("offset"); // Reset to page 1
    setSearchParams(newParams);
    setSelectedIds(new Set()); // Clear selection on page size change
  };

  // Pagination handlers
  const handlePrevPage = () => {
    const newOffset = Math.max(0, offset - pageSize);
    const newParams = new URLSearchParams(searchParams);
    if (newOffset === 0) {
      newParams.delete("offset");
    } else {
      newParams.set("offset", String(newOffset));
    }
    setSearchParams(newParams);
    setSelectedIds(new Set());
  };

  const handleNextPage = () => {
    const newParams = new URLSearchParams(searchParams);
    newParams.set("offset", String(offset + pageSize));
    setSearchParams(newParams);
    setSelectedIds(new Set());
  };

  const currentPage = Math.floor(offset / pageSize) + 1;
  const hasNextPage = emails?.length === pageSize;

  // Selection helpers
  const allSelected =
    emails && emails.length > 0 && emails.every((e) => selectedIds.has(e.id));
  const someSelected = emails?.some((e) => selectedIds.has(e.id));

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(emails?.map((e) => e.id) || []));
    }
  };

  const toggleOne = (id: number) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Inbox</h1>
          <p className="text-muted-foreground">
            Review and manage emails by category
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <Button
              variant="outline"
              onClick={() => bulkMutation.mutate("force-retriage")}
              disabled={bulkMutation.isPending}
            >
              {bulkMutation.isPending
                ? "Processing..."
                : `Re-triage (${selectedIds.size})`}
            </Button>
          )}
        </div>
      </div>

      {/* Tabs with content */}
      <Card>
        <CardContent className="p-0">
          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList className="w-full justify-start rounded-none border-b bg-transparent p-0">
              {MESSAGE_TYPES.map((type) => (
                <TabsTrigger
                  key={type}
                  value={type}
                  className="gap-2 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:shadow-none"
                >
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                  <span className={`h-5 px-1.5 text-xs rounded-md inline-flex items-center ${TAB_COLORS[type]}`}>
                    {stats?.byMessageType?.[type] ?? 0}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>

            {/* Toolbar row */}
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={toggleAll}
                />
                <span className="text-sm text-muted-foreground">
                  {selectedIds.size > 0
                    ? `${selectedIds.size} selected`
                    : "Select all"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Show:</span>
                <Select
                  value={String(pageSize)}
                  onValueChange={handlePageSizeChange}
                >
                  <SelectTrigger className="w-[80px] h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZES.map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Email list */}
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
                    <TableHead className="w-[40px]"></TableHead>
                    <TableHead className="w-[140px]">Date</TableHead>
                    <TableHead className="w-[200px]">From</TableHead>
                    <TableHead>Subject</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {emails.map((email) => (
                    <TableRow
                      key={email.id}
                      className={selectedIds.has(email.id) ? "bg-muted/50" : ""}
                    >
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(email.id)}
                          onCheckedChange={() => toggleOne(email.id)}
                        />
                      </TableCell>
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
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="flex flex-col items-center justify-center py-12">
                <Mail className="h-12 w-12 text-muted-foreground mb-4" />
                <p className="text-muted-foreground">
                  No {activeTab} emails found
                </p>
              </div>
            )}

            {/* Pagination */}
            {emails && emails.length > 0 && (
              <div className="flex items-center justify-between px-4 py-3 border-t">
                <span className="text-sm text-muted-foreground">
                  Page {currentPage}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePrevPage}
                    disabled={offset === 0}
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleNextPage}
                    disabled={!hasNextPage}
                  >
                    Next
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
