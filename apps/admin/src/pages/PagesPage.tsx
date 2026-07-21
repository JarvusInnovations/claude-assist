import { useQuery } from "@tanstack/react-query";
import { FileText, ExternalLink } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
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

import { pagesApi } from "@/api/pages";
import type { PageSummary } from "@/types/api";

function fmt(dt: string | null): string {
  return dt ? new Date(dt).toLocaleString() : "—";
}

export function PagesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["pages"],
    queryFn: () => pagesApi.listPages("include"),
    refetchInterval: 15000,
  });

  const pages = data?.pages ?? [];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Pages</h1>
        <p className="text-muted-foreground">
          Published pages and their response backlog, newest activity first
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : pages.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Page</TableHead>
                  <TableHead className="w-[150px]">Status</TableHead>
                  <TableHead className="w-[120px]">Responses</TableHead>
                  <TableHead className="w-[90px]">Versions</TableHead>
                  <TableHead className="w-[180px]">Updated</TableHead>
                  <TableHead className="w-[180px]">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pages.map((p: PageSummary) => {
                  const archived = p.archived_at !== null;
                  const hasBacklog = p.unprocessed_count > 0;
                  return (
                    <TableRow key={p.slug} className={archived ? "opacity-60" : ""}>
                      <TableCell className="max-w-[420px]">
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-medium hover:underline"
                        >
                          <span className="truncate">{p.title}</span>
                          <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                        </a>
                        <div className="text-xs text-muted-foreground truncate">{p.slug}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge variant={archived ? "outline" : "secondary"}>
                            {archived ? "archived" : "active"}
                          </Badge>
                          {p.digest_optin && <Badge variant="outline">digest</Badge>}
                        </div>
                      </TableCell>
                      <TableCell>
                        {p.response_count === 0 ? (
                          <span className="text-sm text-muted-foreground">none</span>
                        ) : (
                          <Badge variant={hasBacklog ? "default" : "secondary"}>
                            {p.unprocessed_count} / {p.response_count}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {p.version_count}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {fmt(p.updated_at)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {fmt(p.created_at)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="flex flex-col items-center justify-center py-12">
              <FileText className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No pages published yet</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
