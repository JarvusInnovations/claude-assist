import { api } from "../../client.js";
import { parseArgs, rawJson } from "../../args.js";
import { renderObject, renderOutput } from "../../toon.js";

export const STATS_HELP = `gmail-axi stats [--account ID] [--days N] [--json]

  Email counts over the last N days (default 7), broken down by workflow status,
  analysis message type, and sender type.`;

export async function statsCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"]);
  const stats = await api.get("/api/google/emails/stats", {
    account: typeof flags.account === "string" ? flags.account : undefined,
    days: typeof flags.days === "string" ? flags.days : undefined,
  });
  if (flags.json) return rawJson(stats);
  return renderOutput([
    renderObject({ days: stats.days }),
    renderObject({ by_status: stats.byStatus ?? {} }),
    renderObject({ by_message_type: stats.byMessageType ?? {} }),
    renderObject({ by_sender_type: stats.bySenderType ?? {} }),
  ]);
}
