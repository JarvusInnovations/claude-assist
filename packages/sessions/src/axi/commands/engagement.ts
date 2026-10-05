import { api } from "../client.js";
import { parseArgs, rawJson, requireFlag } from "../args.js";
import { renderList, renderObject, renderOutput, field, custom, type FieldDef } from "../toon.js";

const USAGE = "sessions-axi engagement --from YYYY-MM-DD --to YYYY-MM-DD [--tz IANA] [--block-minutes N] [--gap-minutes N] [--sessions] [--json]";

export const ENGAGEMENT_HELP = `${USAGE}

  Human hands-on time per local day and per project — the figure for "how much
  time did I spend on X?". Loop firings, task notifications and other automated
  turns are excluded, and parallel sessions never double-count.

  --from/--to are local dates, inclusive (at most 92 days). Days are bucketed in
  --tz when given, otherwise in the server's SESSIONS_OWNER_TZ; the zone used is
  echoed. Minutes are not additive: project and session minutes can exceed the
  day's envelope when work interleaves. --sessions adds a per-session breakdown,
  including automated minutes.`;

const DAY_SCHEMA: FieldDef[] = [
  field("date"),
  field("envelope_minutes", "envelope_min"),
  field("human_prompt_count", "prompts"),
  field("first_human_prompt", "first"),
  field("last_human_prompt", "last"),
];

const PROJECT_SCHEMA: FieldDef[] = [
  field("date"),
  custom("project", (p) => p.project_name ?? p.project_path ?? "—"),
  field("human_minutes", "human_min"),
  field("human_prompt_count", "prompts"),
];

const SESSION_SCHEMA: FieldDef[] = [
  field("date"),
  field("id"),
  custom("project", (s) => s.project_name ?? s.project_path ?? "—"),
  custom("title", (s) => s.title ?? s.session_name ?? null),
  field("human_minutes", "human_min"),
  field("human_prompt_count", "prompts"),
  field("automated_minutes", "auto_min"),
  field("automated_prompt_count", "auto_prompts"),
];

export async function engagementCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json", "sessions"]);
  const str = (name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);

  const result = await api.get("/api/sessions/engagement", {
    from: requireFlag(flags, "from", USAGE),
    to: requireFlag(flags, "to", USAGE),
    // Sent only when asked for: the server's owner zone is the default, never
    // this machine's zone (specs/behaviors/session-engagement.md).
    tz: str("tz"),
    block_minutes: str("block-minutes"),
    gap_minutes: str("gap-minutes"),
  });
  if (flags.json) return rawJson(result);

  const days: any[] = Array.isArray(result.days) ? result.days : [];
  const totalMin = days.reduce((sum, d) => sum + (d.envelope_minutes ?? 0), 0);
  const flatten = (key: "projects" | "sessions") =>
    days.flatMap((d) => (d[key] ?? []).map((row: any) => ({ date: d.date, ...row })));
  const projects = flatten("projects");
  const sessions = flags.sessions ? flatten("sessions") : [];

  return renderOutput([
    renderObject({
      from: result.from,
      to: result.to,
      tz: result.tz,
      block_minutes: result.block_minutes,
      gap_minutes: result.gap_minutes,
      envelope_hours: Math.round((totalMin / 60) * 10) / 10,
      ...(result.pending_sessions > 0
        ? { pending_sessions: `${result.pending_sessions} (backfill incomplete — figures are a lower bound)` }
        : {}),
    }),
    renderList("days", days, DAY_SCHEMA),
    projects.length ? renderList("projects", projects, PROJECT_SCHEMA) : "",
    sessions.length ? renderList("sessions", sessions, SESSION_SCHEMA) : "",
  ]);
}
