import { AxiError } from "axi-sdk-js";
import { api } from "../../client.js";
import { parseArgs, requireFlag, requirePositional, validateDate, rawJson } from "../../args.js";
import { renderList, renderDetail, renderObject, renderOutput, renderHelp, field, custom, type FieldDef } from "../../toon.js";
import { cliInvocation } from "../../invocation.js";

export const ACCOUNTS_HELP = `google-axi accounts [--json]

  List all Google accounts with credential, sync, and triage status.`;

const LIST_SCHEMA: FieldDef[] = [
  field("id"),
  field("identifier"),
  field("email"),
  field("display_name", "name"),
  { type: "boolYesNo", key: "is_primary", as: "primary" },
  { type: "boolYesNo", key: "has_credentials", as: "authed" },
  field("email_last_sync_at", "last_sync"),
  custom("syncing", (a) => (a.email_sync_status?.syncing ? "yes" : "no")),
];

export async function accountsCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"]);
  const rows = await api.get("/api/google/accounts");
  if (flags.json) return rawJson(rows);
  if (!Array.isArray(rows) || rows.length === 0) {
    const cli = cliInvocation();
    return renderOutput([
      "accounts: none configured",
      renderHelp([`Run \`${cli} account create --identifier <id> --email <addr>\` to add one`]),
    ]);
  }
  const needAuth = rows.filter((a: any) => !a.has_credentials).length;
  return renderOutput([
    `count: ${rows.length}${needAuth ? `, ${needAuth} need authorization` : ""}`,
    renderList("accounts", rows, LIST_SCHEMA),
  ]);
}

const DETAIL_SCHEMA: FieldDef[] = [
  field("id"),
  field("identifier"),
  field("email"),
  field("display_name", "name"),
  { type: "boolYesNo", key: "is_primary", as: "primary" },
  { type: "boolYesNo", key: "has_credentials", as: "authed" },
  field("email_last_sync_at", "last_sync"),
  field("email_sync_start_date", "sync_start"),
  field("email_label_prefix", "label_prefix"),
  field("email_label_prefix_todo", "label_prefix_todo"),
  field("email_triage_instructions", "triage_instructions"),
];

/** Dispatch for the `account <verb> ...` command group. */
export async function accountCommand(args: string[]): Promise<string> {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case "get":
      return getAccount(rest);
    case "create":
      return createAccount(rest);
    case "update":
      return updateAccount(rest);
    case "reauth":
      return reauthAccount(rest);
    case "delete":
      return deleteAccount(rest);
    default:
      throw new AxiError(`Unknown account subcommand: ${verb ?? "(none)"}`, "VALIDATION_ERROR", [
        "Use: account get|create|update|reauth|delete",
      ]);
  }
}

async function getAccount(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"]);
  const id = requirePositional(positionals, 0, "account id", "google-axi account get <id>");
  const account = await api.get(`/api/google/accounts/${encodeURIComponent(id)}`);
  if (flags.json) return rawJson(account);
  return renderDetail("account", account, DETAIL_SCHEMA);
}

async function createAccount(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"]);
  const usage = "google-axi account create --identifier ID --email EMAIL [--name NAME]";
  const identifier = requireFlag(flags, "identifier", usage);
  const email = requireFlag(flags, "email", usage);
  const body: Record<string, unknown> = { identifier, email };
  if (typeof flags.name === "string") body.display_name = flags.name;
  const result = await api.post("/api/google/accounts", body);
  if (flags.json) return rawJson(result);
  return renderOutput([
    renderObject({ created: "account", id: result.id, identifier: result.identifier, email: result.email }),
    `Open this URL in a browser to authorize, then the account is ready to sync:`,
    String(result.authUrl ?? ""),
  ]);
}

async function updateAccount(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json", "primary"]);
  const usage = "google-axi account update <id> [--name ...] [--primary] [--triage-instructions ...] ...";
  const id = requirePositional(positionals, 0, "account id", usage);
  const body: Record<string, unknown> = {};
  if (typeof flags.name === "string") body.display_name = flags.name;
  if (flags.primary) body.is_primary = true;
  if (typeof flags["triage-instructions"] === "string") body.email_triage_instructions = flags["triage-instructions"];
  if (typeof flags["label-prefix"] === "string") body.email_label_prefix = flags["label-prefix"];
  if (typeof flags["label-prefix-todo"] === "string") body.email_label_prefix_todo = flags["label-prefix-todo"];
  if (typeof flags["sync-start-date"] === "string")
    body.email_sync_start_date = validateDate(flags["sync-start-date"], "--sync-start-date", usage);
  if (Object.keys(body).length === 0) {
    throw new AxiError("Nothing to update — pass at least one field", "VALIDATION_ERROR", [usage]);
  }
  const result = await api.patch(`/api/google/accounts/${encodeURIComponent(id)}`, body);
  if (flags.json) return rawJson(result);
  return renderObject({ updated: result.id, identifier: result.identifier });
}

async function reauthAccount(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"]);
  const id = requirePositional(positionals, 0, "account id", "google-axi account reauth <id>");
  const result = await api.post(`/api/google/accounts/${encodeURIComponent(id)}/reauth`);
  if (flags.json) return rawJson(result);
  return renderOutput([`Open this URL in a browser to re-authorize account ${id}:`, String(result.authUrl ?? "")]);
}

async function deleteAccount(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"]);
  const id = requirePositional(positionals, 0, "account id", "google-axi account delete <id>");
  const result = await api.del(`/api/google/accounts/${encodeURIComponent(id)}`);
  if (flags.json) return rawJson(result);
  return renderObject({ deleted: id, success: result?.success ?? true });
}
