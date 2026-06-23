import { api } from "../client.js";
import { parseArgs, rawJson } from "../args.js";
import { renderList, renderOutput, field, relativeTime, type FieldDef } from "../toon.js";

export const MACHINES_HELP = `sessions-axi machines [--json]

  Registered machines and their sync status.`;

const SCHEMA: FieldDef[] = [
  field("machine_id", "machine"),
  field("hostname"),
  { type: "boolYesNo", key: "is_localhost", as: "localhost" },
  field("session_count", "sessions"),
  relativeTime("last_sync_at", "last_sync"),
];

export async function machinesCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"]);
  const rows = await api.get("/api/machines");
  if (flags.json) return rawJson(rows);
  if (!Array.isArray(rows) || rows.length === 0) return "machines: none registered";
  return renderOutput([`count: ${rows.length}`, renderList("machines", rows, SCHEMA)]);
}
