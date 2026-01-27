import { useParams, Link } from "react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ArrowLeft, Play, ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";

import { googleApi } from "@/api/google";

export function EmailDetailPage() {
  const { id } = useParams();
  const emailId = parseInt(id!, 10);

  const { data: email, isLoading, refetch } = useQuery({
    queryKey: ["emails", emailId],
    queryFn: () => googleApi.getEmail(emailId),
  });

  const triageMutation = useMutation({
    mutationFn: () => googleApi.triageEmail(emailId),
    onSuccess: () => {
      toast.success("Email triaged");
      refetch();
    },
    onError: (error) => {
      toast.error(`Triage failed: ${error.message}`);
    },
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!email) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Email not found</p>
        <Button variant="link" asChild className="p-0">
          <Link to="/emails">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to emails
          </Link>
        </Button>
      </div>
    );
  }

  const analysis = email.analysis;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/emails">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Link>
        </Button>
        {email.workflow_status !== "triaged" && (
          <Button
            size="sm"
            onClick={() => triageMutation.mutate()}
            disabled={triageMutation.isPending}
          >
            <Play className="mr-2 h-4 w-4" />
            {triageMutation.isPending ? "Triaging..." : "Triage"}
          </Button>
        )}
      </div>

      {/* Email Header */}
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{email.subject || "(No subject)"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 text-sm">
            <div className="flex">
              <span className="w-20 text-muted-foreground">From:</span>
              <span className="font-medium">
                {email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address}
              </span>
            </div>
            <div className="flex">
              <span className="w-20 text-muted-foreground">To:</span>
              <span>{email.to_addresses?.join(", ") || "N/A"}</span>
            </div>
            {email.cc_addresses?.length > 0 && (
              <div className="flex">
                <span className="w-20 text-muted-foreground">CC:</span>
                <span>{email.cc_addresses.join(", ")}</span>
              </div>
            )}
            <div className="flex">
              <span className="w-20 text-muted-foreground">Date:</span>
              <span>
                {email.date ? new Date(email.date).toLocaleString() : "N/A"}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Badge variant={email.workflow_status === "triaged" ? "outline" : "default"}>
              {email.workflow_status}
            </Badge>
            {analysis?.message_type && (
              <Badge variant="secondary">{analysis.message_type}</Badge>
            )}
            {analysis?.sender_type && (
              <Badge variant="secondary">{analysis.sender_type}</Badge>
            )}
            {email.has_attachments && <Badge variant="outline">Has attachments</Badge>}
          </div>

          {email.gmail_labels?.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {email.gmail_labels.map((label) => (
                <Badge key={label} variant="outline" className="text-xs">
                  {label}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Email Body */}
        <Card className="md:col-span-1">
          <CardHeader>
            <CardTitle className="text-lg">Content</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[400px]">
              {email.body_text ? (
                <pre className="text-sm whitespace-pre-wrap font-sans">
                  {email.body_text}
                </pre>
              ) : (
                <p className="text-muted-foreground">No text content</p>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        {/* AI Analysis */}
        <Card className="md:col-span-1">
          <CardHeader>
            <CardTitle className="text-lg">AI Analysis</CardTitle>
          </CardHeader>
          <CardContent>
            {analysis ? (
              <ScrollArea className="h-[400px]">
                <div className="space-y-4">
                  <div>
                    <h4 className="font-medium text-sm mb-1">Overview</h4>
                    <p className="text-sm text-muted-foreground">
                      {analysis.overview}
                    </p>
                  </div>

                  {analysis.potential_action_items?.length > 0 && (
                    <div>
                      <h4 className="font-medium text-sm mb-1">Action Items</h4>
                      <ul className="list-disc list-inside text-sm text-muted-foreground">
                        {analysis.potential_action_items.map((item, i) => (
                          <li key={i}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {analysis.mentioned_people?.length > 0 && (
                    <div>
                      <h4 className="font-medium text-sm mb-1">People Mentioned</h4>
                      <div className="flex flex-wrap gap-1">
                        {analysis.mentioned_people.map((person, i) => (
                          <Badge key={i} variant="outline">
                            {person}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {analysis.mentioned_organizations?.length > 0 && (
                    <div>
                      <h4 className="font-medium text-sm mb-1">Organizations</h4>
                      <div className="flex flex-wrap gap-1">
                        {analysis.mentioned_organizations.map((org, i) => (
                          <Badge key={i} variant="outline">
                            {org}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {analysis.unsubscribe_link && (
                    <div>
                      <h4 className="font-medium text-sm mb-1">Unsubscribe</h4>
                      <a
                        href={analysis.unsubscribe_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-blue-500 hover:underline flex items-center gap-1"
                      >
                        Unsubscribe link
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  )}

                  <Separator />

                  <div>
                    <h4 className="font-medium text-sm mb-1">Rationale</h4>
                    <p className="text-sm text-muted-foreground">
                      {analysis.rationale}
                    </p>
                  </div>
                </div>
              </ScrollArea>
            ) : (
              <div className="flex flex-col items-center justify-center h-[200px]">
                <p className="text-muted-foreground mb-4">Not yet analyzed</p>
                <Button
                  size="sm"
                  onClick={() => triageMutation.mutate()}
                  disabled={triageMutation.isPending}
                >
                  <Play className="mr-2 h-4 w-4" />
                  Analyze Now
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
