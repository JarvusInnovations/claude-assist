import { api } from "../client.js";
import { parseArgs, rawJson } from "../args.js";
import { renderList, renderObject, renderOutput, field, type FieldDef } from "../toon.js";

export const STATS_HELP = `sessions-axi stats [--days N] [--machine ID] [--json]

  Usage statistics over the last N days (default 30): session/message/token
  totals, top tools, top models, and per-machine counts.`;

const TOOL_SCHEMA: FieldDef[] = [field("tool"), field("count")];
const MODEL_SCHEMA: FieldDef[] = [
  field("model"),
  field("session_count", "sessions"),
  field("input_tokens", "in"),
  field("output_tokens", "out"),
  field("cache_read_tokens", "cache_read"),
];
const MACHINE_SCHEMA: FieldDef[] = [field("machine_id", "machine"), field("session_count", "sessions")];

export async function statsCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"]);
  const stats = await api.get("/api/sessions/stats", {
    days: typeof flags.days === "string" ? flags.days : undefined,
    machine: typeof flags.machine === "string" ? flags.machine : undefined,
  });
  if (flags.json) return rawJson(stats);

  return renderOutput([
    renderObject({
      period_days: stats.period_days,
      total_sessions: stats.total_sessions,
      active_days: stats.active_days,
      total_messages: stats.total_messages,
      avg_messages: stats.avg_messages,
      input_tokens: stats.total_input_tokens,
      output_tokens: stats.total_output_tokens,
      unique_projects: stats.unique_projects,
    }),
    Array.isArray(stats.top_tools) && stats.top_tools.length ? renderList("top_tools", stats.top_tools, TOOL_SCHEMA) : "",
    Array.isArray(stats.top_models) && stats.top_models.length
      ? renderList("top_models", stats.top_models, MODEL_SCHEMA)
      : "",
    Array.isArray(stats.sessions_per_machine) && stats.sessions_per_machine.length
      ? renderList("per_machine", stats.sessions_per_machine, MACHINE_SCHEMA)
      : "",
  ]);
}
