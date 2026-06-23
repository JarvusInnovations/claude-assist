import { api } from "../client.js";
import { parseArgs, requirePositional, rawJson } from "../args.js";
import { renderDetail, renderOutput, renderHelp, field, count, custom, type FieldDef } from "../toon.js";
import { cliInvocation } from "../invocation.js";

export const DETAILS_HELP = `sessions-axi details <session-id> [--raw] [--json]

  Session metadata (tokens, tools, files, models). --raw includes the parsed
  raw message array (large); --json returns the raw API object.`;

const SCHEMA: FieldDef[] = [
  field("id"),
  field("machine"),
  field("project_path", "project"),
  field("git_branch", "branch"),
  field("started_at", "started"),
  field("ended_at", "ended"),
  field("user_message_count", "user_msgs"),
  field("message_count", "messages"),
  field("input_tokens"),
  field("output_tokens"),
  field("cache_read_tokens"),
  custom("tools", (s) => (Array.isArray(s.tools_used) ? s.tools_used.join(",") : "none")),
  custom("files_read", (s) => (Array.isArray(s.files_touched?.reads) ? s.files_touched.reads.length : 0)),
  custom("files_written", (s) => (Array.isArray(s.files_touched?.writes) ? s.files_touched.writes.length : 0)),
  custom("models", (s) => (Array.isArray(s.models_used) ? s.models_used.join(",") : "none")),
  field("title"),
  field("outline"),
];

export async function detailsCommand(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json", "raw"]);
  const id = requirePositional(positionals, 0, "session id", DETAILS_HELP);

  const session = await api.get(`/api/sessions/${encodeURIComponent(id)}`, {
    with_raw_messages: flags.raw ? "true" : undefined,
  });
  if (flags.json || flags.raw) return rawJson(session);

  const cli = cliInvocation();
  return renderOutput([
    renderDetail("session", session, SCHEMA),
    renderHelp([`Run \`${cli} transcript ${id}\` to read the conversation`]),
  ]);
}
