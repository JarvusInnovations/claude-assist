import { api, resolveServer } from "../../client.js";
import { parseArgs, rawJson } from "../../args.js";
import { renderOutput, renderHelp, renderObject, renderList, field, custom, type FieldDef } from "../../toon.js";
import { discoveryHelp } from "../reference.js";
import { cliInvocation } from "../../invocation.js";

/**
 * Home view (no-args): the configured Google accounts and whether each is
 * authorized — the first thing you need when setting up or debugging. Degrades
 * gracefully when the server is unreachable.
 */
const SCHEMA: FieldDef[] = [
  field("id"),
  field("identifier"),
  field("email"),
  { type: "boolYesNo", key: "has_credentials", as: "authed" },
  { type: "boolYesNo", key: "is_primary", as: "primary" },
  custom("last_sync", (a) => a.email_last_sync_at ?? "never"),
];

export async function homeCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"]);
  const server = resolveServer();
  const cli = cliInvocation();

  let accounts: any[] | null = null;
  try {
    const res = await api.get("/api/google/accounts");
    accounts = Array.isArray(res) ? res : [];
  } catch {
    accounts = null;
  }

  if (flags.json) return rawJson({ server, accounts });

  const blocks: string[] = [];
  if (accounts === null) {
    blocks.push(renderObject({ server, status: "unreachable" }));
    blocks.push("The server is not reachable. Set CLAUDE_ASSIST_SERVER or start it (cd apps/server && docker-compose up -d).");
  } else if (accounts.length === 0) {
    blocks.push(renderObject({ server, accounts: 0 }));
    blocks.push(`No Google accounts configured yet.`);
  } else {
    const needAuth = accounts.filter((a) => !a.has_credentials).length;
    blocks.push(`accounts: ${accounts.length}${needAuth ? `, ${needAuth} need authorization` : ", all authorized"}`);
    blocks.push(renderList("accounts", accounts, SCHEMA));
  }
  blocks.push(
    renderHelp([
      `Run \`${cli} account create --identifier <id> --email <addr>\` to connect a Gmail account`,
      `Run \`${cli} account reauth <id>\` if an account needs re-authorization`,
      `Run \`${cli} aliases <account-id>\` to manage name aliases; use \`gmail-axi\` for the inbox itself`,
      discoveryHelp(cli),
    ]),
  );
  return renderOutput(blocks);
}
