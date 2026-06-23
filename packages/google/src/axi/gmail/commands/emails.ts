import { api } from "../../client.js";
import { parseArgs, requirePositional, rawJson } from "../../args.js";
import { renderList, renderDetail, renderOutput, renderHelp, field, relativeTime, truncate, custom, type FieldDef } from "../../toon.js";
import { cliInvocation } from "../../invocation.js";

export const EMAILS_HELP = `gmail-axi emails [flags]

  Search and filter synced emails, most recent first.

  --account ID      filter to one account (its identifier, e.g. chris)
  --status STATUS   workflow status: discovered | new | triaged
  --type a,b        analysis message_type(s), comma-separated (e.g. newsletter,alert)
  --search TEXT     full-text search over subject/body
  --with NAME       match a participant in from/to (substring)
  --days N          look back N days (default 30)
  --limit N         max results (default 50, max 500)
  --offset N        pagination offset
  --json            raw API JSON`;

const LIST_SCHEMA: FieldDef[] = [
  field("id"),
  relativeTime("date"),
  custom("from", (e) => e.from_name || e.from_address || "—"),
  truncate("subject", 80),
  custom("type", (e) => e.analysis?.message_type ?? "—"),
  field("workflow_status", "status"),
  field("account_identifier", "account"),
];

export async function emailsCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"]);
  const query: Record<string, string> = {};
  if (typeof flags.account === "string") query.account = flags.account;
  if (typeof flags.status === "string") query.workflow_status = flags.status;
  if (typeof flags.type === "string") query.message_type = flags.type;
  if (typeof flags.search === "string") query.search = flags.search;
  if (typeof flags.with === "string") query.with = flags.with;
  if (typeof flags.days === "string") query.days = flags.days;
  if (typeof flags.limit === "string") query.limit = flags.limit;
  if (typeof flags.offset === "string") query.offset = flags.offset;

  const rows = await api.get("/api/google/emails", query);
  if (flags.json) return rawJson(rows);
  if (!Array.isArray(rows) || rows.length === 0) return "emails: 0 matching emails found";

  const cli = cliInvocation();
  return renderOutput([
    `count: ${rows.length}`,
    renderList("emails", rows, LIST_SCHEMA),
    renderHelp([`Run \`${cli} email <id>\` for full detail and AI analysis`]),
  ]);
}

const DETAIL_SCHEMA: FieldDef[] = [
  field("id"),
  field("date"),
  custom("from", (e) => `${e.from_name ?? ""} <${e.from_address ?? ""}>`.trim()),
  custom("to", (e) => (Array.isArray(e.to_addresses) ? e.to_addresses.join(", ") : e.to_addresses ?? "—")),
  field("subject"),
  truncate("snippet", 500),
  field("workflow_status", "status"),
  field("triaged_at"),
  field("account_identifier", "account"),
  custom("message_type", (e) => e.analysis?.message_type ?? null),
  custom("sender_type", (e) => e.analysis?.sender_type ?? null),
];

export async function emailCommand(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"]);
  const id = requirePositional(positionals, 0, "email id", "gmail-axi email <id>");
  const email = await api.get(`/api/google/emails/${encodeURIComponent(id)}`);
  if (flags.json) return rawJson(email);
  return renderOutput([
    renderDetail("email", email, DETAIL_SCHEMA),
    email.analysis ? rawJson({ analysis: email.analysis }) : "",
  ]);
}
