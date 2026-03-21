import { useParams, Link } from "react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Save, RefreshCw, Trash2, Plus, LogIn } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";

import { googleApi } from "@/api/google";
import type { UpdateAccountPayload } from "@/types/api";

export function AccountDetailPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const accountId = parseInt(id!, 10);

  const [formData, setFormData] = useState<UpdateAccountPayload>({});

  const { data: account, isLoading } = useQuery({
    queryKey: ["accounts", accountId],
    queryFn: () => googleApi.getAccount(accountId),
    refetchInterval: 5000,
  });

  const { data: aliases } = useQuery({
    queryKey: ["accounts", accountId, "aliases"],
    queryFn: () => googleApi.getAliases(accountId),
  });

  const updateMutation = useMutation({
    mutationFn: (data: UpdateAccountPayload) =>
      googleApi.updateAccount(accountId, data),
    onSuccess: () => {
      toast.success("Account updated");
      queryClient.invalidateQueries({ queryKey: ["accounts", accountId] });
    },
    onError: (error) => {
      toast.error(`Update failed: ${error.message}`);
    },
  });

  const syncMutation = useMutation({
    mutationFn: () => googleApi.triggerSync({ account: account?.identifier }),
    onSuccess: () => {
      toast.success("Sync started");
    },
    onError: (error) => {
      toast.error(`Sync failed: ${error.message}`);
    },
  });

  const reauthMutation = useMutation({
    mutationFn: () => googleApi.getReauthUrl(accountId),
    onSuccess: (data) => {
      window.open(data.authUrl, "_blank");
      toast.success("Opened Google sign-in in a new tab");
    },
    onError: (error) => {
      toast.error(`Reconnect failed: ${error.message}`);
    },
  });

  const deleteAliasMutation = useMutation({
    mutationFn: (aliasId: number) => googleApi.deleteAlias(accountId, aliasId),
    onSuccess: () => {
      toast.success("Alias deleted");
      queryClient.invalidateQueries({ queryKey: ["accounts", accountId, "aliases"] });
    },
    onError: (error) => {
      toast.error(`Delete failed: ${error.message}`);
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

  if (!account) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Account not found</p>
        <Button variant="link" asChild className="p-0">
          <Link to="/accounts">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to accounts
          </Link>
        </Button>
      </div>
    );
  }

  const handleSave = () => {
    updateMutation.mutate(formData);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/accounts">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">{account.identifier}</h1>
          <p className="text-muted-foreground">{account.email}</p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Account Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Account Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="display_name">Display Name</Label>
              <Input
                id="display_name"
                defaultValue={account.display_name || ""}
                onChange={(e) =>
                  setFormData({ ...formData, display_name: e.target.value })
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="label_prefix">Label Prefix</Label>
              <Input
                id="label_prefix"
                defaultValue={account.email_label_prefix}
                onChange={(e) =>
                  setFormData({ ...formData, email_label_prefix: e.target.value })
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="label_prefix_todo">Todo Label Prefix</Label>
              <Input
                id="label_prefix_todo"
                defaultValue={account.email_label_prefix_todo}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    email_label_prefix_todo: e.target.value,
                  })
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="sync_start_date">Sync Start Date</Label>
              <Input
                id="sync_start_date"
                type="date"
                defaultValue={account.email_sync_start_date || ""}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    email_sync_start_date: e.target.value || null,
                  })
                }
              />
            </div>

            <Button onClick={handleSave} disabled={updateMutation.isPending}>
              <Save className="mr-2 h-4 w-4" />
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </CardContent>
        </Card>

        {/* Triage Instructions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Triage Instructions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="triage_instructions">Custom Instructions</Label>
              <Textarea
                id="triage_instructions"
                rows={8}
                defaultValue={account.email_triage_instructions || ""}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    email_triage_instructions: e.target.value || null,
                  })
                }
                placeholder="Enter custom instructions for AI email triage..."
              />
            </div>

            <Button onClick={handleSave} disabled={updateMutation.isPending}>
              <Save className="mr-2 h-4 w-4" />
              {updateMutation.isPending ? "Saving..." : "Save Instructions"}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Sync Status */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg">Sync Status</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {syncMutation.isPending ? "Syncing..." : "Sync Now"}
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <p className="text-sm text-muted-foreground">Last Sync</p>
              <p className="font-medium">
                {account.email_last_sync_at
                  ? new Date(account.email_last_sync_at).toLocaleString()
                  : "Never"}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">History ID</p>
              <p className="font-medium font-mono text-sm">
                {account.email_history_id || "N/A"}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">OAuth Status</p>
              <div className="flex items-center gap-2">
                <Badge variant={account.has_credentials ? "default" : "destructive"}>
                  {account.has_credentials ? "Connected" : "Not Connected"}
                </Badge>
                <Button
                  variant={account.has_credentials ? "outline" : "destructive"}
                  size="sm"
                  onClick={() => reauthMutation.mutate()}
                  disabled={reauthMutation.isPending}
                >
                  <LogIn className="mr-2 h-4 w-4" />
                  {reauthMutation.isPending ? "Loading..." : "Reconnect"}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Aliases */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg">Name Aliases</CardTitle>
          <Button variant="outline" size="sm" disabled>
            <Plus className="mr-2 h-4 w-4" />
            Add Alias
          </Button>
        </CardHeader>
        <CardContent>
          {aliases?.length ? (
            <div className="space-y-2">
              {aliases.map((alias) => (
                <div
                  key={alias.id}
                  className="flex items-center justify-between p-2 rounded-md border"
                >
                  <div>
                    <span className="font-medium">{alias.alias}</span>
                    {alias.is_owner && (
                      <Badge variant="secondary" className="ml-2">
                        Owner
                      </Badge>
                    )}
                    {alias.refers_to && (
                      <span className="text-sm text-muted-foreground ml-2">
                        → {alias.refers_to}
                      </span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteAliasMutation.mutate(alias.id)}
                    disabled={deleteAliasMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No aliases configured</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
