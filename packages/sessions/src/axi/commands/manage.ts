import { api } from "../client.js";
import { parseArgs, requirePositional, captureJson } from "../args.js";
import { renderObject, renderOutput, renderHelp } from "../toon.js";
import { cliInvocation } from "../invocation.js";

export const OUTLINES_HELP = `sessions-axi outlines [<session-id>...] [--json-out[=path]]
sessions-axi outlines progress [--json-out[=path]]

  Generate AI outlines for sessions missing or with stale ones (needs the
  server's model invoker). With no ids, processes all pending.
  \`outlines progress\` reports background generation status.
  --json-out[=path] writes the API response to a file (bare: an owner-only
  temp file); stdout stays this view.`;

export async function outlinesCommand(args: string[]): Promise<string> {
  const { positionals } = parseArgs("outlines", args);

  if (positionals[0] === "progress") {
    const progress = await api.get("/api/sessions/outlines/progress");
    captureJson(progress);
    return renderObject(progress ?? { status: "no progress data" });
  }

  const sessionIds = positionals.filter(Boolean);
  const result = await api.post("/api/sessions/outlines", sessionIds.length ? { sessionIds } : {});
  captureJson(result);
  const cli = cliInvocation();
  return renderOutput([
    renderObject(result ?? { status: "queued" }),
    renderHelp([`Run \`${cli} outlines progress\` to watch generation`]),
  ]);
}

export const SYNC_HELP = `sessions-axi sync [--force] [--json-out[=path]]

  Trigger an immediate sync of local (~/.claude) sessions. --force re-parses all
  sessions even when the content hash is unchanged (use after a parser upgrade).
  --json-out[=path] writes the API response to a file.`;

export async function syncCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs("sync", args);
  const result = await api.post("/api/sessions/sync", undefined, flags.force ? { force: "true" } : undefined);
  captureJson(result);
  return renderObject(result ?? { status: "done" });
}

export const SHARE_HELP = `sessions-axi share <session-id> [--json-out[=path]]

  Mint a shareable auth code granting read access to a session's transcript.
  --json-out[=path] writes the API response to a file.`;

export async function shareCommand(args: string[]): Promise<string> {
  const { positionals } = parseArgs("share", args);
  const id = requirePositional(positionals, 0, "session id", SHARE_HELP);
  const result = await api.post(`/api/sessions/${encodeURIComponent(id)}/share`);
  captureJson(result);
  return renderObject({ session: id, auth_code: result?.auth_code ?? null });
}
