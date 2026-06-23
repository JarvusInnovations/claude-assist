import { AxiError } from "axi-sdk-js";
import { api } from "../../client.js";
import { parseArgs, requirePositional, rawJson } from "../../args.js";
import { renderObject, renderOutput, renderHelp } from "../../toon.js";
import { cliInvocation } from "../../invocation.js";

export const SYNC_HELP = `gmail-axi sync [--account ID] [--full] [--json]

  Trigger a Gmail sync (async — returns immediately). Without --account, syncs
  every account with stored credentials. --full re-reads full history instead of
  incremental. Watch progress via \`google-axi accounts\`.`;

export async function syncCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json", "full"]);
  const body: Record<string, unknown> = {};
  if (typeof flags.account === "string") body.account = flags.account;
  if (flags.full) body.full = true;
  const result = await api.post("/api/google/emails/sync", body);
  if (flags.json) return rawJson(result);
  return renderObject(result ?? { status: "requested" });
}

export const TRIAGE_HELP = `gmail-axi triage [<email-id>] [--account ID] [--limit N] [--force] [--json]
gmail-axi triage progress [--json]

  With an <email-id>, triage that single email synchronously. With no id, kick
  off an async batch over pending ('new') emails — or 'new'+'triaged' with
  --force. \`triage progress\` reports recent counts. Needs ANTHROPIC_API_KEY.`;

export async function triageCommand(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json", "force"]);

  if (positionals[0] === "progress") {
    const progress = await api.get("/api/google/emails/triage/progress");
    if (flags.json) return rawJson(progress);
    return renderObject(progress ?? {});
  }

  const cli = cliInvocation();
  // Single-email triage when a numeric id is given.
  if (positionals[0]) {
    const id = positionals[0];
    const result = await api.post(`/api/google/emails/${encodeURIComponent(id)}/triage`);
    if (flags.json) return rawJson(result);
    return renderObject(result ?? { triaged: id });
  }

  // Batch triage of pending emails.
  const body: Record<string, unknown> = {};
  if (typeof flags.account === "string") body.account = flags.account;
  if (typeof flags.limit === "string") body.limit = parseInt(flags.limit, 10);
  if (flags.force) body.force = true;
  const result = await api.post("/api/google/emails/triage", body);
  if (flags.json) return rawJson(result);
  return renderOutput([
    renderObject(result ?? { status: "started" }),
    renderHelp([`Run \`${cli} triage progress\` to watch`]),
  ]);
}

export const BULK_ACTION_HELP = `gmail-axi bulk-action <action> <email-id>... [--json]

  Run a bulk action over a list of email ids. Supported: force-retriage
  (re-runs AI triage). Other actions are accepted as no-op placeholders.`;

export async function bulkActionCommand(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"]);
  const action = requirePositional(positionals, 0, "action", BULK_ACTION_HELP);
  const ids = positionals.slice(1).map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
  if (ids.length === 0) {
    throw new AxiError("At least one email id is required", "VALIDATION_ERROR", [BULK_ACTION_HELP]);
  }
  const result = await api.post("/api/google/emails/bulk-action", { action, emailIds: ids });
  if (flags.json) return rawJson(result);
  return renderObject(result ?? { action, count: ids.length });
}
