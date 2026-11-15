import { AxiError } from "axi-sdk-js";
import { api } from "../client.js";
import { parseArgs, requirePositional, captureJson } from "../args.js";
import { renderDetail, renderList, renderOutput, renderHelp, field, joinArray, custom, truncate, type FieldDef } from "../toon.js";
import { cliInvocation } from "../invocation.js";

export const DETAILS_HELP = `sessions-axi details <session-id> [--raw] [--json-out[=path]]

  Session metadata (tokens, tools, files, models).

  --json-out[=path]  write the full API object to a file (bare: an owner-only
                     temp file); stdout stays this view
  --raw              add the parsed raw message array (large) to that file;
                     needs --json-out

  A windowed session (specs/behaviors/session-outlines.md) also shows its
  per-window summaries, and — once it's grown enough windows — the chapter
  rollups summarizing groups of them.`;

const SCHEMA: FieldDef[] = [
  field("id"),
  field("machine"),
  field("project_path"),
  field("git_branch"),
  field("started_at"),
  field("ended_at"),
  field("user_message_count"),
  field("message_count"),
  field("input_tokens"),
  field("output_tokens"),
  field("cache_read_tokens"),
  joinArray("tools_used"),
  custom("files_read", (s) => (Array.isArray(s.files_touched?.reads) ? s.files_touched.reads.length : 0)),
  custom("files_written", (s) => (Array.isArray(s.files_touched?.writes) ? s.files_touched.writes.length : 0)),
  joinArray("models_used"),
  field("title"),
  field("outline"),
];

const WINDOW_SCHEMA: FieldDef[] = [
  field("window_index"),
  custom("range", (w) => `${w.from_seq}-${w.to_seq}`),
  custom("state", (w) => (w.closed ? "closed" : "open")),
  field("status"),
  truncate("summary", 200),
];

const ROLLUP_SCHEMA: FieldDef[] = [
  field("level"),
  field("rollup_index"),
  custom("range", (r) => `${r.from_seq}-${r.to_seq}`),
  field("status"),
  truncate("summary", 200),
];

export async function detailsCommand(args: string[]): Promise<string> {
  const { positionals, flags, jsonOut } = parseArgs("details", args);
  const id = requirePositional(positionals, 0, "session id", DETAILS_HELP);
  const cli = cliInvocation();
  // The raw message array has no TOON form: it only ever goes to the file.
  if (flags.raw && !jsonOut) {
    throw new AxiError("--raw adds the raw messages to the JSON export, so it needs --json-out", "VALIDATION_ERROR", [
      `Run \`${cli} details ${id} --raw --json-out\` to write them to a file`,
    ]);
  }

  const session = await api.get(`/api/sessions/${encodeURIComponent(id)}`, {
    with_raw_messages: flags.raw ? "true" : undefined,
  });
  captureJson(session);

  const blocks = [renderDetail("session", session, SCHEMA)];
  if (Array.isArray(session.outline_windows) && session.outline_windows.length > 0) {
    blocks.push(renderList("outline_windows", session.outline_windows, WINDOW_SCHEMA));
  }
  if (Array.isArray(session.outline_rollups) && session.outline_rollups.length > 0) {
    blocks.push(renderList("outline_rollups", session.outline_rollups, ROLLUP_SCHEMA));
  }
  blocks.push(renderHelp([`Run \`${cli} transcript ${id}\` to read the conversation`]));
  return renderOutput(blocks);
}
