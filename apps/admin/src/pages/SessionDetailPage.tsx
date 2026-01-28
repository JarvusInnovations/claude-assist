import { useParams, Link } from "react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ArrowLeft, Sparkles, FileText, Clock, Hash } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { sessionsApi } from "@/api/sessions";

export function SessionDetailPage() {
  const { id } = useParams();
  const sessionId = id!;

  const { data: session, isLoading, refetch } = useQuery({
    queryKey: ["sessions", sessionId],
    queryFn: () => sessionsApi.getSession(sessionId),
  });

  const { data: transcript } = useQuery({
    queryKey: ["sessions", sessionId, "transcript"],
    queryFn: () => sessionsApi.getTranscript(sessionId),
    enabled: !!session,
  });

  const outlineMutation = useMutation({
    mutationFn: () => sessionsApi.triggerOutlines([sessionId]),
    onSuccess: () => {
      toast.success("Outline generation started");
      refetch();
    },
    onError: (error) => {
      toast.error(`Failed: ${error.message}`);
    },
  });

  const formatTokens = (tokens: number) => {
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(2)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
    return tokens.toString();
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Session not found</p>
        <Button variant="link" asChild className="p-0">
          <Link to="/sessions">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to sessions
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/sessions">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Link>
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-semibold truncate">
            {session.project_path?.split("/").pop() || "Session"}
          </h1>
          <p className="text-muted-foreground text-sm truncate">
            {session.project_path}
          </p>
        </div>
        {!session.outline && (
          <Button
            size="sm"
            onClick={() => outlineMutation.mutate()}
            disabled={outlineMutation.isPending}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            {outlineMutation.isPending ? "Generating..." : "Generate Outline"}
          </Button>
        )}
      </div>

      {/* Session Metadata */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Clock className="h-4 w-4" />
              Started
            </div>
            <p className="font-medium">
              {new Date(session.started_at).toLocaleString()}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <FileText className="h-4 w-4" />
              Messages
            </div>
            <p className="font-medium">{session.message_count}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Hash className="h-4 w-4" />
              Branch
            </div>
            <p className="font-medium">{session.git_branch || "N/A"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-sm text-muted-foreground mb-1">Version</div>
            <p className="font-medium font-mono text-sm">
              {session.claude_version || "N/A"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Token Usage */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Token Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-4">
            <div>
              <p className="text-sm text-muted-foreground">Input</p>
              <p className="text-2xl font-bold">
                {formatTokens(session.input_tokens)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Output</p>
              <p className="text-2xl font-bold">
                {formatTokens(session.output_tokens)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Cache Read</p>
              <p className="text-2xl font-bold">
                {formatTokens(session.cache_read_tokens)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total</p>
              <p className="text-2xl font-bold">
                {formatTokens(
                  session.input_tokens +
                    session.output_tokens +
                    session.cache_read_tokens
                )}
              </p>
            </div>
          </div>

          {session.models_used?.length > 0 && (
            <>
              <Separator className="my-4" />
              <div>
                <p className="text-sm text-muted-foreground mb-2">
                  Models Used
                </p>
                <div className="flex flex-wrap gap-2">
                  {session.models_used.map((model) => (
                    <Badge key={model} variant="secondary">
                      {model}
                    </Badge>
                  ))}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Outline & Transcript */}
      <Card>
        <CardContent className="p-0">
          <Tabs defaultValue="outline">
            <TabsList className="w-full justify-start rounded-none border-b bg-transparent p-0">
              <TabsTrigger
                value="outline"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary"
              >
                Outline
              </TabsTrigger>
              <TabsTrigger
                value="transcript"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary"
              >
                Transcript
              </TabsTrigger>
              <TabsTrigger
                value="tools"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary"
              >
                Tools ({session.tools_used?.length || 0})
              </TabsTrigger>
              <TabsTrigger
                value="files"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary"
              >
                Files ({(session.files_touched?.reads?.length || 0) + (session.files_touched?.writes?.length || 0)})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="outline" className="p-4">
              {session.outline ? (
                <ScrollArea className="h-[400px]">
                  <pre className="text-sm whitespace-pre-wrap font-sans">
                    {session.outline}
                  </pre>
                </ScrollArea>
              ) : (
                <div className="flex flex-col items-center justify-center h-[200px]">
                  <p className="text-muted-foreground mb-4">
                    No outline generated
                  </p>
                  <Button
                    size="sm"
                    onClick={() => outlineMutation.mutate()}
                    disabled={outlineMutation.isPending}
                  >
                    <Sparkles className="mr-2 h-4 w-4" />
                    Generate Outline
                  </Button>
                </div>
              )}
            </TabsContent>

            <TabsContent value="transcript" className="p-4">
              <ScrollArea className="h-[400px]">
                {transcript ? (
                  <pre className="text-sm whitespace-pre-wrap font-mono">
                    {transcript}
                  </pre>
                ) : (
                  <p className="text-muted-foreground">Loading transcript...</p>
                )}
              </ScrollArea>
            </TabsContent>

            <TabsContent value="tools" className="p-4">
              <ScrollArea className="h-[400px]">
                {session.tools_used?.length ? (
                  <div className="flex flex-wrap gap-2">
                    {session.tools_used.map((tool, i) => (
                      <Badge key={i} variant="outline">
                        {tool}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">No tools used</p>
                )}
              </ScrollArea>
            </TabsContent>

            <TabsContent value="files" className="p-4">
              <ScrollArea className="h-[400px]">
                {(session.files_touched?.reads?.length || session.files_touched?.writes?.length) ? (
                  <div className="space-y-4">
                    {session.files_touched?.writes?.length ? (
                      <div>
                        <h4 className="text-sm font-medium text-muted-foreground mb-2">
                          Written ({session.files_touched.writes.length})
                        </h4>
                        <div className="space-y-1">
                          {session.files_touched.writes.map((file, i) => (
                            <div key={i} className="text-sm font-mono">
                              {file}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {session.files_touched?.reads?.length ? (
                      <div>
                        <h4 className="text-sm font-medium text-muted-foreground mb-2">
                          Read ({session.files_touched.reads.length})
                        </h4>
                        <div className="space-y-1">
                          {session.files_touched.reads.map((file, i) => (
                            <div key={i} className="text-sm font-mono">
                              {file}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-muted-foreground">No files touched</p>
                )}
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
