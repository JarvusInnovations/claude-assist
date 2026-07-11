import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ChevronDown,
  Inbox,
  Loader2,
  Mail,
  ShieldAlert,
  Tag,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { digestApi } from "@/api/digest";
import type {
  DigestEmail,
  DigestPendingResponse,
  GmailAction,
} from "@/types/api";

const ACTIONS: GmailAction[] = ["leave", "archive", "spam"];

// The badge/label the row shows: an explicit gmail_action, or "label" when the
// only staged effect is applying labels (action stays 'leave').
function effectiveAction(email: DigestEmail, override?: GmailAction): GmailAction {
  return override ?? email.gmail_action ?? "leave";
}

function actionKind(
  email: DigestEmail,
  override?: GmailAction
): "archive" | "spam" | "label" | "leave" {
  const action = effectiveAction(email, override);
  if (action === "archive") return "archive";
  if (action === "spam") return "spam";
  if (email.planned_labels && email.planned_labels.length > 0) return "label";
  return "leave";
}

function ActionBadge({ kind }: { kind: ReturnType<typeof actionKind> }) {
  if (kind === "archive")
    return (
      <Badge variant="secondary">
        <Archive /> Archive
      </Badge>
    );
  if (kind === "spam")
    return (
      <Badge variant="destructive">
        <ShieldAlert /> Spam
      </Badge>
    );
  if (kind === "label")
    return (
      <Badge variant="outline">
        <Tag /> Label
      </Badge>
    );
  return <Badge variant="ghost">Leave</Badge>;
}

function senderName(e: DigestEmail): string {
  return e.from_name || e.from_address || "unknown sender";
}

function whenLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function DigestPage() {
  const queryClient = useQueryClient();

  const { data: pending, isLoading } = useQuery({
    queryKey: ["digest-pending"],
    queryFn: () => digestApi.getPending(),
    refetchInterval: 30000,
  });

  const { data: history } = useQuery({
    queryKey: ["digest-history"],
    queryFn: () => digestApi.getHistory(7),
  });

  const [tab, setTab] = useState("pending");

  // Per-row approve (default true) and per-row action override (modify flow).
  const [approved, setApproved] = useState<Record<number, boolean>>({});
  const [overrides, setOverrides] = useState<Record<number, GmailAction>>({});

  const allEmails = useMemo(
    () => pending?.sections.flatMap((s) => s.emails) ?? [],
    [pending]
  );

  // Seed newly-arrived ids to approved=true without clobbering user toggles,
  // and prune ids that dropped out (executed elsewhere).
  useEffect(() => {
    setApproved((prev) => {
      const next: Record<number, boolean> = {};
      for (const e of allEmails) next[e.id] = prev[e.id] ?? true;
      return next;
    });
  }, [allEmails]);

  const approvedIds = useMemo(
    () => allEmails.filter((e) => approved[e.id] !== false).map((e) => e.id),
    [allEmails, approved]
  );

  const executeMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      // Apply per-row action overrides first (PATCH), then confirm-to-execute.
      const patches = ids
        .filter(
          (id) =>
            overrides[id] &&
            overrides[id] !== allEmails.find((e) => e.id === id)?.gmail_action
        )
        .map((id) => digestApi.updateAction(id, overrides[id]!));
      await Promise.all(patches);
      return digestApi.execute(ids);
    },
    // Optimistic: drop the approved rows from the pending view immediately.
    onMutate: async (ids: number[]) => {
      await queryClient.cancelQueries({ queryKey: ["digest-pending"] });
      const snapshot = queryClient.getQueryData<DigestPendingResponse>([
        "digest-pending",
      ]);
      const idSet = new Set(ids);
      queryClient.setQueryData<DigestPendingResponse>(
        ["digest-pending"],
        (old) => {
          if (!old) return old;
          const sections = old.sections
            .map((s) => ({
              ...s,
              emails: s.emails.filter((e) => !idSet.has(e.id)),
            }))
            .filter((s) => s.emails.length > 0)
            .map((s) => ({ ...s, count: s.emails.length }));
          return {
            count: sections.reduce((n, s) => n + s.count, 0),
            sections,
          };
        }
      );
      return { snapshot };
    },
    onError: (error, _ids, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData(["digest-pending"], context.snapshot);
      }
      toast.error(`Execute failed: ${(error as Error).message}`);
    },
    onSuccess: (res) => {
      if (res.failed > 0) {
        toast.warning(
          `Executed ${res.succeeded} of ${res.requested} — ${res.failed} failed`
        );
      } else {
        toast.success(`Executed ${res.succeeded} action(s)`);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["digest-pending"] });
      queryClient.invalidateQueries({ queryKey: ["digest-history"] });
    },
  });

  const toggleRow = (id: number) =>
    setApproved((prev) => ({ ...prev, [id]: prev[id] === false }));

  const setSectionApproval = (emails: DigestEmail[], value: boolean) =>
    setApproved((prev) => {
      const next = { ...prev };
      for (const e of emails) next[e.id] = value;
      return next;
    });

  const setOverride = (id: number, action: GmailAction) =>
    setOverrides((prev) => ({ ...prev, [id]: action }));

  const pendingCount = allEmails.length;

  return (
    <div className="flex flex-col min-h-svh">
      <div className="px-4 pt-4 pb-2 md:px-6">
        <h1 className="text-xl font-semibold md:text-2xl">Digest</h1>
        <p className="text-sm text-muted-foreground">
          Confirm the planned email actions.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex-1">
        <div className="px-4 md:px-6">
          <TabsList className="w-full">
            <TabsTrigger value="pending" className="flex-1">
              Pending
              {pendingCount > 0 && (
                <Badge variant="secondary" className="ml-1.5">
                  {pendingCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="history" className="flex-1">
              History
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Pending — extra bottom padding leaves room for the sticky bar */}
        <TabsContent value="pending" className="px-4 md:px-6 pb-40 space-y-3">
          {isLoading ? (
            <div className="space-y-3 pt-2">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : pendingCount === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <CheckCircle2 className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">
                Nothing pending — triage is keeping up.
              </p>
            </div>
          ) : (
            pending!.sections.map((section) => {
              const allApproved = section.emails.every(
                (e) => approved[e.id] !== false
              );
              return (
                <Collapsible
                  key={section.section}
                  defaultOpen
                  className="rounded-lg border"
                >
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    <CollapsibleTrigger className="flex flex-1 items-center gap-2 text-left [&[data-state=open]>svg]:rotate-180">
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform" />
                      <span className="font-medium capitalize">
                        {section.section}
                      </span>
                      <Badge variant="secondary">{section.count}</Badge>
                    </CollapsibleTrigger>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-xs"
                      onClick={() =>
                        setSectionApproval(section.emails, !allApproved)
                      }
                    >
                      {allApproved ? "Skip all" : "Approve all"}
                    </Button>
                  </div>

                  <CollapsibleContent className="divide-y border-t">
                    {section.emails.map((email) => {
                      const isApproved = approved[email.id] !== false;
                      const override = overrides[email.id];
                      return (
                        <div
                          key={email.id}
                          className={
                            "px-3 py-3 transition-opacity " +
                            (isApproved ? "" : "opacity-50")
                          }
                        >
                          <div className="flex items-start gap-3">
                            {/* Large touch target: checkbox with padded label */}
                            <label className="flex cursor-pointer items-center pt-0.5">
                              <Checkbox
                                checked={isApproved}
                                onCheckedChange={() => toggleRow(email.id)}
                                className="h-5 w-5"
                                aria-label={
                                  isApproved
                                    ? `Skip ${senderName(email)}`
                                    : `Approve ${senderName(email)}`
                                }
                              />
                            </label>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-start justify-between gap-2">
                                <span className="truncate font-medium">
                                  {senderName(email)}
                                </span>
                                <ActionBadge
                                  kind={actionKind(email, override)}
                                />
                              </div>
                              <div className="truncate text-sm">
                                {email.subject || "(no subject)"}
                              </div>
                              {email.analysis?.overview && (
                                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                                  {email.analysis.overview}
                                </p>
                              )}

                              <div className="mt-2 flex items-center gap-2">
                                <Select
                                  value={effectiveAction(email, override)}
                                  onValueChange={(v) =>
                                    setOverride(email.id, v as GmailAction)
                                  }
                                >
                                  <SelectTrigger
                                    size="sm"
                                    className="h-8 w-[130px] text-xs"
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {ACTIONS.map((a) => (
                                      <SelectItem
                                        key={a}
                                        value={a}
                                        className="capitalize"
                                      >
                                        {a}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <span className="truncate text-xs text-muted-foreground">
                                  {email.account_identifier}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </CollapsibleContent>
                </Collapsible>
              );
            })
          )}
        </TabsContent>

        <TabsContent value="history" className="px-4 md:px-6 pb-20 space-y-2">
          {!history || history.count === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Mail className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="text-muted-foreground">
                No actions executed in the last {history?.days ?? 7} days.
              </p>
            </div>
          ) : (
            <>
              <p className="pt-1 text-xs text-muted-foreground">
                {history.count} action(s) executed in the last {history.days}{" "}
                days
              </p>
              {history.emails.map((email) => (
                <div
                  key={email.id}
                  className="flex items-start gap-3 rounded-lg border px-3 py-2.5"
                >
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {senderName(email)}
                      </span>
                      <ActionBadge kind={actionKind(email)} />
                    </div>
                    <div className="truncate text-sm text-muted-foreground">
                      {email.subject || "(no subject)"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {whenLabel(email.date)}
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </TabsContent>
      </Tabs>

      {/* Sticky action bar — only meaningful on the Pending tab */}
      {tab === "pending" && pendingCount > 0 && (
        <div className="sticky bottom-0 z-10 border-t bg-background/95 px-4 py-3 backdrop-blur md:px-6 [padding-bottom:calc(0.75rem+env(safe-area-inset-bottom))]">
          <Button
            className="h-12 w-full text-base"
            disabled={approvedIds.length === 0 || executeMutation.isPending}
            onClick={() => executeMutation.mutate(approvedIds)}
          >
            {executeMutation.isPending ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" /> Executing…
              </>
            ) : (
              <>
                <Inbox className="h-5 w-5" />
                Execute {approvedIds.length} action
                {approvedIds.length === 1 ? "" : "s"}
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
