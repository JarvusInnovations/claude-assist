import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ChevronDown,
  Inbox,
  Loader2,
  Mail,
  MoreVertical,
  ShieldAlert,
  ShieldCheck,
  Tag,
  CheckCircle2,
  MailX,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { digestApi } from "@/api/digest";
import type {
  DigestItem,
  DigestSectionPayload,
  DigestPendingResponse,
  GmailAction,
} from "@/types/api";

const ACTIONS: GmailAction[] = ["leave", "archive", "spam"];

// The category/tier options a reclassify offers, mapped to the placement fields
// the reclassify endpoint applies immediately for that one email.
const RECLASS_TARGETS: {
  value: string;
  label: string;
  digest_section?: string;
  gmail_action: GmailAction;
}[] = [
  { value: "actionable", label: "Actionable (needs response)", digest_section: "personal", gmail_action: "leave" },
  { value: "calendar", label: "Calendar", digest_section: "calendar", gmail_action: "archive" },
  { value: "financial", label: "Financial", digest_section: "financial", gmail_action: "archive" },
  { value: "opportunities", label: "Opportunities", digest_section: "opportunities", gmail_action: "archive" },
  { value: "newsletters", label: "Newsletters", digest_section: "newsletters", gmail_action: "archive" },
  { value: "archive", label: "Archive (routine)", digest_section: "notifications", gmail_action: "archive" },
  { value: "spam", label: "Spam / quarantine", digest_section: "spam", gmail_action: "spam" },
];

function actionKind(
  action: GmailAction,
  plannedLabels: string[] | null
): "archive" | "spam" | "label" | "leave" {
  if (action === "archive") return "archive";
  if (action === "spam") return "spam";
  if (plannedLabels && plannedLabels.length > 0) return "label";
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

function senderName(e: { from_name: string | null; from_address: string | null }): string {
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

  // Reclassify dialog state.
  const [reclassItem, setReclassItem] = useState<DigestItem | null>(null);
  const [reclassTarget, setReclassTarget] = useState<string>("archive");
  const [reclassNote, setReclassNote] = useState("");

  const allItems = useMemo(
    () => pending?.sections.flatMap((s) => s.items) ?? [],
    [pending]
  );

  // Seed newly-arrived ids to approved=true without clobbering user toggles.
  useEffect(() => {
    setApproved((prev) => {
      const next: Record<number, boolean> = {};
      for (const e of allItems) next[e.id] = prev[e.id] ?? true;
      return next;
    });
  }, [allItems]);

  const approvedIds = useMemo(
    () => allItems.filter((e) => approved[e.id] !== false).map((e) => e.id),
    [allItems, approved]
  );

  const executeMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const patches = ids
        .filter(
          (id) =>
            overrides[id] &&
            overrides[id] !== allItems.find((e) => e.id === id)?.planned_action
        )
        .map((id) => digestApi.updateAction(id, overrides[id]!));
      await Promise.all(patches);
      return digestApi.execute(ids);
    },
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
            .map((s) => ({ ...s, items: s.items.filter((e) => !idSet.has(e.id)) }))
            .filter((s) => s.items.length > 0)
            .map((s) => ({ ...s, count: s.items.length }));
          return { count: sections.reduce((n, s) => n + s.count, 0), sections };
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

  const standingMutation = useMutation({
    mutationFn: ({
      email,
      standing,
    }: {
      email: string;
      standing: "whitelist" | "unsubscribe_queue";
    }) => digestApi.setSenderStanding(email, standing),
    onSuccess: (_res, vars) => {
      toast.success(
        vars.standing === "whitelist"
          ? "Whitelisted — you won't be asked about this sender again"
          : "Queued for unsubscribe"
      );
      queryClient.invalidateQueries({ queryKey: ["digest-pending"] });
    },
    onError: (error) => toast.error(`Failed: ${(error as Error).message}`),
  });

  const reclassifyMutation = useMutation({
    mutationFn: async () => {
      if (!reclassItem) return;
      const target = RECLASS_TARGETS.find((t) => t.value === reclassTarget)!;
      return digestApi.reclassify(reclassItem.id, {
        to_class: target.value,
        digest_section: target.digest_section,
        gmail_action: target.gmail_action,
        note: reclassNote.trim() || undefined,
      });
    },
    onSuccess: () => {
      toast.success("Reclassified — correction queued for review");
      setReclassItem(null);
      setReclassNote("");
      queryClient.invalidateQueries({ queryKey: ["digest-pending"] });
    },
    onError: (error) => toast.error(`Failed: ${(error as Error).message}`),
  });

  const toggleRow = (id: number) =>
    setApproved((prev) => ({ ...prev, [id]: prev[id] === false }));

  const setSectionApproval = (items: DigestItem[], value: boolean) =>
    setApproved((prev) => {
      const next = { ...prev };
      for (const e of items) next[e.id] = value;
      return next;
    });

  const setOverride = (id: number, action: GmailAction) =>
    setOverrides((prev) => ({ ...prev, [id]: action }));

  const openReclassify = (item: DigestItem) => {
    setReclassItem(item);
    setReclassTarget(item.digest_section ?? "archive");
    setReclassNote("");
  };

  const pendingCount = allItems.length;

  const renderItemRow = (item: DigestItem) => {
    const isApproved = approved[item.id] !== false;
    const override = overrides[item.id];
    const effective = override ?? item.planned_action;
    return (
      <div
        key={item.id}
        className={"px-3 py-3 transition-opacity " + (isApproved ? "" : "opacity-50")}
      >
        <div className="flex items-start gap-3">
          <label className="flex cursor-pointer items-center pt-0.5">
            <Checkbox
              checked={isApproved}
              onCheckedChange={() => toggleRow(item.id)}
              className="h-5 w-5"
              aria-label={isApproved ? `Skip ${senderName(item)}` : `Approve ${senderName(item)}`}
            />
          </label>

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <span className="truncate font-medium">
                <span className="mr-1" aria-hidden>
                  {item.sender_kind === "human" ? "👤" : "🤖"}
                </span>
                {senderName(item)}
                {item.rolled_over && (
                  <Badge variant="outline" className="ml-2 text-xs">
                    {item.age_days}d old
                  </Badge>
                )}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <ActionBadge kind={actionKind(effective, item.planned_labels)} />
                <RowMenu
                  item={item}
                  onWhitelist={() =>
                    item.from_address &&
                    standingMutation.mutate({ email: item.from_address, standing: "whitelist" })
                  }
                  onUnsubscribe={() =>
                    item.from_address &&
                    standingMutation.mutate({ email: item.from_address, standing: "unsubscribe_queue" })
                  }
                  onReclassify={() => openReclassify(item)}
                />
              </div>
            </div>
            <div className="truncate text-sm">{item.subject || "(no subject)"}</div>
            {item.gist && (
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.gist}</p>
            )}

            <div className="mt-2 flex items-center gap-2">
              <Select
                value={effective}
                onValueChange={(v) => setOverride(item.id, v as GmailAction)}
              >
                <SelectTrigger size="sm" className="h-8 w-[130px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACTIONS.map((a) => (
                    <SelectItem key={a} value={a} className="capitalize">
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="truncate text-xs text-muted-foreground">
                {item.account_identifier}
                {item.date ? ` · ${new Date(item.date).toLocaleDateString()}` : ""}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderSection = (section: DigestSectionPayload) => {
    const allApproved = section.items.every((e) => approved[e.id] !== false);
    const isSummary = section.render === "summary";
    // Actionable stays open by default; summaries + disposables collapse.
    const defaultOpen = section.key === "actionable";
    return (
      <Collapsible key={section.key} defaultOpen={defaultOpen} className="rounded-lg border">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <CollapsibleTrigger className="flex flex-1 items-center gap-2 text-left [&[data-state=open]>svg]:rotate-180">
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform" />
            <span className="font-medium">{section.title}</span>
            <Badge variant="secondary">{section.count}</Badge>
            {isSummary && (
              <Badge variant="outline" className="text-xs">
                summary
              </Badge>
            )}
          </CollapsibleTrigger>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-xs"
            onClick={() => setSectionApproval(section.items, !allApproved)}
          >
            {allApproved ? "Skip all" : "Approve all"}
          </Button>
        </div>

        <CollapsibleContent className="border-t">
          {isSummary && section.summary && section.summary.length > 0 && (
            <ul className="space-y-1 px-4 py-3 text-sm">
              {section.summary.map((line, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-muted-foreground">•</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          )}

          {isSummary ? (
            // Summary sections expand to the underlying per-email detail.
            <Collapsible className="border-t">
              <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-muted-foreground [&[data-state=open]>svg]:rotate-180">
                <ChevronDown className="h-3.5 w-3.5 transition-transform" />
                Show {section.count} email{section.count === 1 ? "" : "s"}
              </CollapsibleTrigger>
              <CollapsibleContent className="divide-y border-t">
                {section.items.map(renderItemRow)}
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <div className="divide-y">{section.items.map(renderItemRow)}</div>
          )}
        </CollapsibleContent>
      </Collapsible>
    );
  };

  return (
    <div className="flex flex-col min-h-svh">
      <div className="px-4 pt-4 pb-2 md:px-6">
        <h1 className="text-xl font-semibold md:text-2xl">Digest</h1>
        <p className="text-sm text-muted-foreground">
          Actionable first, then summarized categories. Confirm to execute.
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
            pending!.sections.map(renderSection)
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
                {history.count} action(s) executed in the last {history.days} days
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
                      <ActionBadge
                        kind={actionKind(email.gmail_action ?? "leave", email.planned_labels)}
                      />
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
                Execute {approvedIds.length} action{approvedIds.length === 1 ? "" : "s"}
              </>
            )}
          </Button>
        </div>
      )}

      {/* Reclassify dialog */}
      <Dialog open={!!reclassItem} onOpenChange={(o) => !o && setReclassItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reclassify</DialogTitle>
            <DialogDescription>
              Corrects this one email now and queues the change for a review
              session. Triage rules are not modified.
            </DialogDescription>
          </DialogHeader>
          {reclassItem && (
            <p className="truncate text-sm text-muted-foreground">
              {senderName(reclassItem)} — {reclassItem.subject || "(no subject)"}
            </p>
          )}
          <div className="space-y-3">
            <Select value={reclassTarget} onValueChange={setReclassTarget}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RECLASS_TARGETS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              placeholder="Optional note — why this is misclassified (helps the review session)"
              value={reclassNote}
              onChange={(e) => setReclassNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReclassItem(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => reclassifyMutation.mutate()}
              disabled={reclassifyMutation.isPending}
            >
              {reclassifyMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Reclassify
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Per-row overflow menu: newsletter standing + reclassify. */
function RowMenu({
  item,
  onWhitelist,
  onUnsubscribe,
  onReclassify,
}: {
  item: DigestItem;
  onWhitelist: () => void;
  onUnsubscribe: () => void;
  onReclassify: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="More actions">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {item.is_newsletter && (
          <>
            <DropdownMenuItem onClick={onWhitelist} disabled={!item.from_address}>
              <ShieldCheck className="h-4 w-4" /> Whitelist sender
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onUnsubscribe} disabled={!item.from_address}>
              <MailX className="h-4 w-4" /> Queue unsubscribe
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={onReclassify}>
          <Pencil className="h-4 w-4" /> Reclassify…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
