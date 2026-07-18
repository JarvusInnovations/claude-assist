import { useState } from "react";
import { Share2, Copy, Check, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { sessionsApi } from "@/api/sessions";

interface ShareDialogProps {
  sessionId: string;
}

export function ShareDialog({ sessionId }: ShareDialogProps) {
  const [authCode, setAuthCode] = useState<string | null>(null);
  const [copied, setCopied] = useState<"html" | "text" | null>(null);

  const origin = window.location.origin.replace(
    window.location.hostname,
    `claude-assist.${window.location.hostname.split(".").slice(1).join(".")}`
  );
  // In development the app is served from a dev host whose origin isn't the
  // publicly shareable one, so rewrite to the canonical `claude-assist.` origin.
  // In production the current origin is already canonical — use it as-is.
  // `process.env.NODE_ENV` is statically replaced at build time by the bundler.
  const isProduction = process.env.NODE_ENV === "production";
  const baseUrl = isProduction ? window.location.origin : origin;
  const htmlUrl = authCode ? `${baseUrl}/share/${authCode}` : "";
  const textUrl = authCode ? `${baseUrl}/share/${authCode}/text` : "";

  const shareMutation = useMutation({
    mutationFn: () => sessionsApi.createShare(sessionId),
    onSuccess: (data) => {
      setAuthCode(data.auth_code);
    },
    onError: (err) => {
      toast.error(`Failed to create share link: ${err.message}`);
    },
  });

  function handleOpenChange(open: boolean) {
    if (open && !authCode) {
      shareMutation.mutate();
    }
    if (!open) {
      // Reset copied state on close but keep authCode so reopening is instant
      setCopied(null);
    }
  }

  async function copyUrl(type: "html" | "text") {
    const url = type === "html" ? htmlUrl : textUrl;
    await navigator.clipboard.writeText(url);
    setCopied(type);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <Dialog onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Share2 className="mr-2 h-4 w-4" />
          Share
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share Transcript</DialogTitle>
        </DialogHeader>

        {shareMutation.isPending ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            Generating share link…
          </p>
        ) : authCode ? (
          <div className="space-y-5 py-2">
            <p className="text-sm text-muted-foreground">
              Anyone with these links can view the transcript — no login required.
            </p>

            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                View (HTML)
              </Label>
              <div className="flex gap-2">
                <Input readOnly value={htmlUrl} className="font-mono text-xs" />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copyUrl("html")}
                  title="Copy HTML link"
                >
                  {copied === "html" ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  asChild
                  title="Open in new tab"
                >
                  <a href={htmlUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Agent / Plain Text
              </Label>
              <div className="flex gap-2">
                <Input readOnly value={textUrl} className="font-mono text-xs" />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copyUrl("text")}
                  title="Copy plain text link"
                >
                  {copied === "text" ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Use this URL to feed the transcript directly to an AI agent.
              </p>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
