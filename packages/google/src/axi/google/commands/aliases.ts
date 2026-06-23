import { AxiError } from "axi-sdk-js";
import { api } from "../../client.js";
import { parseArgs, requireFlag, requirePositional, rawJson } from "../../args.js";
import { renderList, renderObject, renderOutput, renderHelp, field, type FieldDef } from "../../toon.js";
import { cliInvocation } from "../../invocation.js";

export const ALIASES_HELP = `google-axi aliases <account-id>                                  # list
google-axi aliases add <account-id> --alias NAME [--not-owner] [--refers-to NAME] [--notes TEXT]
google-axi aliases remove <account-id> <alias-id>

  Name aliases help disambiguate who an email is from/to and who commitments
  refer to. By default a new alias is marked as referring to the account owner;
  pass --not-owner (with --refers-to) for someone else.`;

const SCHEMA: FieldDef[] = [
  field("id"),
  field("alias"),
  { type: "boolYesNo", key: "is_owner", as: "owner" },
  field("refers_to"),
  field("notes"),
];

export async function aliasesCommand(args: string[]): Promise<string> {
  const verb = args[0];
  if (verb === "add") return addAlias(args.slice(1));
  if (verb === "remove") return removeAlias(args.slice(1));
  return listAliases(args);
}

async function listAliases(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"]);
  const accountId = requirePositional(positionals, 0, "account id", "google-axi aliases <account-id>");
  const rows = await api.get(`/api/google/accounts/${encodeURIComponent(accountId)}/aliases`);
  if (flags.json) return rawJson(rows);
  if (!Array.isArray(rows) || rows.length === 0) {
    const cli = cliInvocation();
    return renderOutput([
      "aliases: none",
      renderHelp([`Run \`${cli} aliases add ${accountId} --alias "<name>"\` to add one`]),
    ]);
  }
  return renderOutput([`count: ${rows.length}`, renderList("aliases", rows, SCHEMA)]);
}

async function addAlias(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json", "not-owner"]);
  const usage = "google-axi aliases add <account-id> --alias NAME [--not-owner] [--refers-to NAME] [--notes TEXT]";
  const accountId = requirePositional(positionals, 0, "account id", usage);
  const alias = requireFlag(flags, "alias", usage);
  const body: Record<string, unknown> = { alias, is_owner: !flags["not-owner"] };
  if (typeof flags["refers-to"] === "string") body.refers_to = flags["refers-to"];
  if (typeof flags.notes === "string") body.notes = flags.notes;
  if (flags["not-owner"] && !body.refers_to) {
    throw new AxiError("--not-owner requires --refers-to <name>", "VALIDATION_ERROR", [usage]);
  }
  const created = await api.post(`/api/google/accounts/${encodeURIComponent(accountId)}/aliases`, body);
  if (flags.json) return rawJson(created);
  return renderObject({ created: "alias", id: created.id, alias: created.alias, refers_to: created.refers_to });
}

async function removeAlias(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"]);
  const usage = "google-axi aliases remove <account-id> <alias-id>";
  const accountId = requirePositional(positionals, 0, "account id", usage);
  const aliasId = requirePositional(positionals, 1, "alias id", usage);
  const result = await api.del(
    `/api/google/accounts/${encodeURIComponent(accountId)}/aliases/${encodeURIComponent(aliasId)}`,
  );
  if (flags.json) return rawJson(result);
  return renderObject({ removed: aliasId, success: result?.success ?? true });
}
