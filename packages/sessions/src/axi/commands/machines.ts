import { api } from "../client.js";
import { parseArgs, captureJson } from "../args.js";
import { renderList, renderOutput, field, relativeTime, type FieldDef } from "../toon.js";

export const MACHINES_HELP = `sessions-axi machines [--json-out[=path]]

  Registered machines and their sync status. --json-out[=path] writes the full
  JSON to a file (bare: an owner-only temp file); stdout stays this view.`;

const SCHEMA: FieldDef[] = [
  field("machine_id"),
  field("hostname"),
  { type: "boolYesNo", key: "is_localhost" },
  field("session_count"),
  relativeTime("last_sync_at"),
];

export async function machinesCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs("machines", args);
  const rows = await api.get("/api/machines");
  captureJson(rows);
  if (!Array.isArray(rows) || rows.length === 0) return "machines: none registered";
  return renderOutput([`count: ${rows.length}`, renderList("machines", rows, SCHEMA)]);
}
