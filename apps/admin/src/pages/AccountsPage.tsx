import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "react-router";
import { Plus, ExternalLink, CheckCircle, XCircle, LogIn } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

import { googleApi } from "@/api/google";

export function AccountsPage() {
  const { data: accounts, isLoading } = useQuery({
    queryKey: ["accounts"],
    queryFn: googleApi.getAccounts,
    refetchInterval: 10000,
  });

  const reauthMutation = useMutation({
    mutationFn: (id: number) => googleApi.getReauthUrl(id),
    onSuccess: (data) => {
      window.open(data.authUrl, "_blank");
      toast.success("Opened Google sign-in in a new tab");
    },
    onError: (error) => {
      toast.error(`Reconnect failed: ${error.message}`);
    },
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Google Accounts</h1>
          <p className="text-muted-foreground">
            Manage connected Gmail accounts
          </p>
        </div>
        <Button disabled>
          <Plus className="mr-2 h-4 w-4" />
          Add Account
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-6 w-32" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-full mb-2" />
                <Skeleton className="h-4 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : accounts?.length ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {accounts.map((account) => (
            <Card key={account.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-lg">{account.identifier}</CardTitle>
                {account.has_credentials ? (
                  <CheckCircle className="h-5 w-5 text-green-500" />
                ) : (
                  <XCircle className="h-5 w-5 text-red-500" />
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-sm text-muted-foreground">{account.email}</p>
                  {account.display_name && (
                    <p className="text-sm">{account.display_name}</p>
                  )}
                </div>

                <div className="flex flex-wrap gap-1">
                  {account.is_primary && <Badge>Primary</Badge>}
                  {account.has_credentials ? (
                    <Badge variant="outline">Connected</Badge>
                  ) : (
                    <Badge variant="destructive">Not Connected</Badge>
                  )}
                </div>

                <div className="text-xs text-muted-foreground">
                  {account.email_last_sync_at
                    ? `Last sync: ${new Date(account.email_last_sync_at).toLocaleString()}`
                    : "Never synced"}
                </div>

                <div className="flex gap-2">
                  {!account.has_credentials && (
                    <Button
                      variant="destructive"
                      size="sm"
                      className="flex-1"
                      onClick={() => reauthMutation.mutate(account.id)}
                      disabled={reauthMutation.isPending}
                    >
                      <LogIn className="mr-2 h-4 w-4" />
                      Reconnect
                    </Button>
                  )}
                  <Button variant="outline" size="sm" asChild className="flex-1">
                    <Link to={`/accounts/${account.id}`}>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Manage
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">No accounts configured</p>
            <Button disabled>
              <Plus className="mr-2 h-4 w-4" />
              Add Your First Account
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
