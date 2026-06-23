import { api } from "../client.js";
import { parseArgs, rawJson } from "../args.js";
import { renderList, renderOutput, field, custom, type FieldDef } from "../toon.js";

export const ACTIVITY_HELP = `sessions-axi activity [--days N] [--json]

  When work happened — contiguous active time blocks per session (segmented by a
  30-minute gap). Use for "when was I working?" / "how much time on X?". Default
  look-back is 7 days.`;

const SCHEMA: FieldDef[] = [
  field("id"),
  custom("project", (s) => s.project_name ?? s.project_path ?? "—"),
  custom("title", (s) => s.title ?? s.session_name ?? null),
  field("total_active_minutes", "active_min"),
  custom("ranges", (s) => (Array.isArray(s.activity_ranges) ? s.activity_ranges.length : 0)),
];

export async function activityCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"]);
  const rows = await api.get("/api/sessions/activity", {
    days: typeof flags.days === "string" ? flags.days : undefined,
  });
  if (flags.json) return rawJson(rows);
  if (!Array.isArray(rows) || rows.length === 0) return "activity: no active sessions in range";

  const totalMin = rows.reduce((sum: number, r: any) => sum + (r.total_active_minutes ?? 0), 0);
  return renderOutput([
    `count: ${rows.length} sessions, ${Math.round((totalMin / 60) * 10) / 10}h total active`,
    renderList("activity", rows, SCHEMA),
  ]);
}
