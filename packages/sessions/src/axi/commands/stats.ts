import { api } from "../client.js";
import { parseArgs, captureJson } from "../args.js";
import { renderList, renderObject, renderOutput, field, type FieldDef } from "../toon.js";

export const STATS_HELP = `sessions-axi stats [--days N] [--machine ID] [--json-out[=path]]

  Usage statistics over the last N days (default 30): session/message/token
  totals, top tools, top models, and per-machine counts. --json-out[=path] writes the
  full JSON to a file (bare: an owner-only temp file); stdout stays this view.`;

const TOOL_SCHEMA: FieldDef[] = [field("tool"), field("count")];
const MODEL_SCHEMA: FieldDef[] = [
  field("model"),
  field("session_count"),
  field("input_tokens"),
  field("output_tokens"),
  field("cache_read_tokens"),
];
const MACHINE_SCHEMA: FieldDef[] = [field("machine_id"), field("session_count")];

export async function statsCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs("stats", args);
  const stats = await api.get("/api/sessions/stats", {
    days: typeof flags.days === "string" ? flags.days : undefined,
    machine: typeof flags.machine === "string" ? flags.machine : undefined,
  });
  captureJson(stats);

  return renderOutput([
    renderObject({
      period_days: stats.period_days,
      total_sessions: stats.total_sessions,
      active_days: stats.active_days,
      total_messages: stats.total_messages,
      avg_messages: stats.avg_messages,
      total_input_tokens: stats.total_input_tokens,
      total_output_tokens: stats.total_output_tokens,
      unique_projects: stats.unique_projects,
    }),
    Array.isArray(stats.top_tools) && stats.top_tools.length ? renderList("top_tools", stats.top_tools, TOOL_SCHEMA) : "",
    Array.isArray(stats.top_models) && stats.top_models.length
      ? renderList("top_models", stats.top_models, MODEL_SCHEMA)
      : "",
    Array.isArray(stats.sessions_per_machine) && stats.sessions_per_machine.length
      ? renderList("sessions_per_machine", stats.sessions_per_machine, MACHINE_SCHEMA)
      : "",
  ]);
}
