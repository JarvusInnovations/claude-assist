import { api } from "../client.js";
import { parseArgs, rawJson, validateDate } from "../args.js";
import { renderList, renderOutput, renderHelp, field, count, relativeTime, custom, type FieldDef } from "../toon.js";
import { cliInvocation } from "../invocation.js";

export const SEARCH_HELP = `sessions-axi search [flags]

  Find past sessions by topic, tool, or file. Full-text search is weighted
  (user prompts + outlines > tools/files > project path).

  --query TEXT             full-text search query (omit to list recent sessions)
  --project PATH           filter by project path (substring match)
  --days N                 limit to the last N days (default 30)
  --since DATE             absolute start (ISO 8601 / YYYY-MM-DD); overrides --days
  --until DATE             absolute end (ISO 8601 / YYYY-MM-DD)
  --forever                no date limit (for "have we ever…?" questions)
  --tools a,b              tools used — comma-separated substring matches (e.g. Bash,mcp__slack)
  --files-read frag        a read file path contains this substring
  --files-written frag     a written file path contains this substring
  --machine ID             filter by machine id (e.g. localhost, laptop)
  --min-user-messages N    hide subagent sessions (default behavior: pass 2)
  --include-empty          include sessions with no assistant output
  --limit N                max results (default 20, max 100)
  --offset N               pagination offset
  --json                   raw API JSON`;

function shortProject(p: unknown): string {
  if (typeof p !== "string" || !p) return "—";
  return p.split("/").filter(Boolean).pop() ?? p;
}

const SCHEMA: FieldDef[] = [
  field("id"),
  relativeTime("started_at", "started"),
  custom("project", (s) => shortProject(s.project_path)),
  custom("title", (s) => s.title ?? s.session_name ?? null),
  field("user_message_count", "user_msgs"),
  count("tools_used", "tools"),
  field("machine"),
];

export async function searchCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json", "forever", "include-empty"]);

  const query: Record<string, string> = {};
  if (typeof flags.query === "string") query.search = flags.query;
  if (typeof flags.project === "string") query.project = flags.project;
  if (typeof flags.days === "string") query.days = flags.days;
  if (typeof flags.since === "string") query.since = validateDate(flags.since, "--since", SEARCH_HELP);
  if (typeof flags.until === "string") query.until = validateDate(flags.until, "--until", SEARCH_HELP);
  if (flags.forever) query.forever = "true";
  if (typeof flags.tools === "string") query.tools = flags.tools;
  if (typeof flags["files-read"] === "string") query.files_read = flags["files-read"];
  if (typeof flags["files-written"] === "string") query.files_written = flags["files-written"];
  if (typeof flags.machine === "string") query.machine = flags.machine;
  if (typeof flags["min-user-messages"] === "string") query.min_user_messages = flags["min-user-messages"];
  if (flags["include-empty"]) query.include_empty = "true";
  if (typeof flags.limit === "string") query.limit = flags.limit;
  if (typeof flags.offset === "string") query.offset = flags.offset;

  const rows = await api.get("/api/sessions", query);
  if (flags.json) return rawJson(rows);
  if (!Array.isArray(rows) || rows.length === 0) {
    return "sessions: 0 matching sessions found";
  }

  const cli = cliInvocation();
  return renderOutput([
    `count: ${rows.length}${rows.length === (parseInt(query.limit ?? "20", 10)) ? " (limit reached — page with --offset)" : ""}`,
    renderList("sessions", rows, SCHEMA),
    renderHelp([`Run \`${cli} transcript <session-id>\` to read one`]),
  ]);
}
