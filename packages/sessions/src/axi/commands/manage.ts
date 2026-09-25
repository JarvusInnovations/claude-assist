import { api } from "../client.js";
import { parseArgs, requirePositional, rawJson } from "../args.js";
import { renderObject, renderOutput, renderHelp } from "../toon.js";
import { cliInvocation } from "../invocation.js";

export const OUTLINES_HELP = `sessions-axi outlines [<session-id>...] [--json]
sessions-axi outlines progress [--json]

  Generate AI outlines for sessions missing or with stale ones (needs the
  server's model invoker). With no ids, processes all pending.
  \`outlines progress\` reports background generation status.`;

export async function outlinesCommand(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"]);

  if (positionals[0] === "progress") {
    const progress = await api.get("/api/sessions/outlines/progress");
    if (flags.json) return rawJson(progress);
    return renderObject(progress ?? { status: "no progress data" });
  }

  const sessionIds = positionals.filter(Boolean);
  const result = await api.post("/api/sessions/outlines", sessionIds.length ? { sessionIds } : {});
  if (flags.json) return rawJson(result);
  const cli = cliInvocation();
  return renderOutput([
    renderObject(result ?? { status: "queued" }),
    renderHelp([`Run \`${cli} outlines progress\` to watch generation`]),
  ]);
}

export const SYNC_HELP = `sessions-axi sync [--force] [--json]

  Trigger an immediate sync of local (~/.claude) sessions. --force re-parses all
  sessions even when the content hash is unchanged (use after a parser upgrade).`;

export async function syncCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json", "force"]);
  const result = await api.post("/api/sessions/sync", undefined, flags.force ? { force: "true" } : undefined);
  if (flags.json) return rawJson(result);
  return renderObject(result ?? { status: "done" });
}

export const SHARE_HELP = `sessions-axi share <session-id> [--json]

  Mint a shareable auth code granting read access to a session's transcript.`;

export async function shareCommand(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"]);
  const id = requirePositional(positionals, 0, "session id", SHARE_HELP);
  const result = await api.post(`/api/sessions/${encodeURIComponent(id)}/share`);
  if (flags.json) return rawJson(result);
  return renderObject({ session: id, auth_code: result?.auth_code ?? null });
}

export const BACKFILL_HELP = `sessions-axi backfill status [--json]

  Progress of the legacy-transcript chunk backfill (converts remaining
  storage='inline' sessions to chunks from raw_transcript — disabled by
  default server-side; this only reports status, it never triggers a run).`;

export async function backfillCommand(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"]);
  if (positionals[0] && positionals[0] !== "status") {
    return renderHelp([BACKFILL_HELP]);
  }
  const status = await api.get("/api/sessions/backfill/status");
  if (flags.json) return rawJson(status);
  return renderObject(
    status ?? { remaining: 0, remaining_bytes: 0, converted: 0, failures: 0 }
  );
}
