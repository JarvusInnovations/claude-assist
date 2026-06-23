import { api, resolveServer } from "../../client.js";
import { parseArgs, rawJson } from "../../args.js";
import { renderOutput, renderHelp, renderObject, renderList, field, relativeTime, type FieldDef } from "../../toon.js";
import { discoveryHelp } from "../reference.js";
import { cliInvocation } from "../../invocation.js";

/**
 * Home view (no-args): a per-account inbox snapshot — last sync, live sync/triage
 * status, and the 7-day new/triaged funnel for each account. Degrades gracefully
 * when the server is unreachable, so it is safe as a SessionStart hook payload.
 */
const SCHEMA: FieldDef[] = [
  field("identifier", "account"),
  field("email"),
  { type: "boolYesNo", key: "has_credentials", as: "authed" },
  relativeTime("email_last_sync_at", "last_sync"),
  field("new_7d", "new"),
  field("triaged_7d", "triaged"),
  field("status"),
];

function liveStatus(account: any): string {
  if (account.email_sync_status?.syncing) return "syncing";
  if (account.email_triage_status?.triaging) return "triaging";
  return "idle";
}

export async function homeCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"]);
  const server = resolveServer();
  const cli = cliInvocation();

  let rows: any[] | null = null;
  try {
    const accounts = await api.get("/api/google/accounts");
    const list = Array.isArray(accounts) ? accounts : [];
    // Pull each account's 7-day funnel in parallel for real per-account metrics
    // (the accounts payload only carries last-sync + ephemeral live status).
    const stats = await Promise.all(
      list.map((a: any) =>
        api.get("/api/google/emails/stats", { account: a.identifier, days: 7 }).catch(() => null),
      ),
    );
    rows = list.map((a: any, i: number) => ({
      ...a,
      new_7d: stats[i]?.byStatus?.new ?? 0,
      triaged_7d: stats[i]?.byStatus?.triaged ?? 0,
      status: liveStatus(a),
    }));
  } catch {
    rows = null;
  }

  if (flags.json) return rawJson({ server, accounts: rows });

  const blocks: string[] = [renderObject({ server })];
  if (rows === null) {
    blocks.push("The server is not reachable. Set CLAUDE_ASSIST_SERVER or start it (cd apps/server && docker-compose up -d).");
  } else if (rows.length === 0) {
    blocks.push("accounts: none configured — set one up with `google-axi account create`");
  } else {
    blocks.push(renderList("accounts", rows, SCHEMA));
  }
  blocks.push(
    renderHelp([
      `Run \`${cli} emails --status new\` to see untriaged email`,
      `Run \`${cli} triage\` to triage pending email, then \`${cli} triage progress\``,
      `Run \`${cli} sync\` to pull new mail; manage accounts with \`google-axi accounts\``,
      discoveryHelp(cli),
    ]),
  );
  return renderOutput(blocks);
}
