import { api } from "../client.js";
import { parseArgs, captureJson } from "../args.js";
import { renderList, renderOutput, field, count, custom, type FieldDef } from "../toon.js";

export const ACTIVITY_HELP = `sessions-axi activity [--days N] [--json-out[=path]]

  When sessions had turns — contiguous time blocks per session (segmented by a
  30-minute gap). Turns of any kind count, including loop firings and task
  notifications, so this is a timeline feed and not a measure of time worked:
  for "how much time on X?" use \`engagement\`. Default look-back is 7 days.
  --json-out[=path] writes the full JSON to a file (bare: an owner-only temp
  file); stdout stays this view.`;

const SCHEMA: FieldDef[] = [
  field("id"),
  custom("project", (s) => s.project_name ?? s.project_path ?? "—"),
  custom("title", (s) => s.title ?? s.session_name ?? null),
  field("total_active_minutes"),
  count("activity_ranges"),
];

export async function activityCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs("activity", args);
  const rows = await api.get("/api/sessions/activity", {
    days: typeof flags.days === "string" ? flags.days : undefined,
  });
  captureJson(rows);
  if (!Array.isArray(rows) || rows.length === 0) return "activity: no active sessions in range";

  const totalMin = rows.reduce((sum: number, r: any) => sum + (r.total_active_minutes ?? 0), 0);
  return renderOutput([
    `count: ${rows.length} sessions, ${Math.round((totalMin / 60) * 10) / 10}h total active`,
    renderList("activity", rows, SCHEMA),
  ]);
}
