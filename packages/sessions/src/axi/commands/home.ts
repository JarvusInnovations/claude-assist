import { execSync } from "node:child_process";
import { basename } from "node:path";
import { homedir } from "node:os";
import { api, resolveServer } from "../client.js";
import { parseArgs, rawJson } from "../args.js";
import { renderOutput, renderHelp, renderObject, renderList, field, relativeTime, custom, formatRelativeTime, type FieldDef } from "../toon.js";
import { discoveryHelp } from "../reference.js";
import { cliInvocation } from "../invocation.js";

/**
 * Home view (no-args invocation). Content-first and project-aware: when invoked
 * inside a git repo it leads with that repo's most recent sessions ("where did
 * we leave off here?") — the highest-value context for a SessionStart hook.
 * Outside a repo (or with --all) it falls back to a global activity snapshot.
 * Resilient: if the server is unreachable it still renders a status line and
 * help instead of erroring.
 *
 * Flags: --all (force the global view), --project NAME (override detection),
 * --recent N (how many sessions to show, default 5).
 */
/** Last activity = session end (the last message), falling back to start. */
function lastActivityMs(s: any): number {
  return new Date(s.ended_at ?? s.started_at).getTime() || 0;
}

const RECENT_SCHEMA: FieldDef[] = [
  field("id"),
  custom("title", (s) => s.title ?? s.session_name ?? null),
  field("machine"),
  relativeTime("started_at", "started"),
  custom("last_activity", (s) => formatRelativeTime(s.ended_at ?? s.started_at)),
];

const MACHINE_SCHEMA: FieldDef[] = [
  field("machine_id", "machine"),
  { type: "boolYesNo", key: "is_localhost", as: "localhost" },
  field("session_count", "sessions"),
  relativeTime("last_sync_at", "last_sync"),
];

/** Detect the git repo containing the current working directory. */
function detectGitProject(): { name: string; root: string } | null {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!root) return null;
    return { name: basename(root), root };
  } catch {
    return null;
  }
}

function collapseHome(p: string): string {
  const home = homedir();
  return home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

export async function homeCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json", "all"]);
  const server = resolveServer();
  const cli = cliInvocation();
  const recentN = typeof flags.recent === "string" ? Math.max(parseInt(flags.recent, 10) || 5, 1) : 5;

  // Resolve project scope: explicit override > git detection (unless --all).
  const override = typeof flags.project === "string" ? flags.project : undefined;
  const detected = flags.all ? null : override ? { name: override, root: process.cwd() } : detectGitProject();

  // ── Project-scoped view ────────────────────────────────────────────────
  if (detected) {
    let recent: any[] | null = null;
    try {
      // The API orders by started_at; fetch a window and re-sort by last
      // activity so "most recent" reflects when work last happened, not when
      // the session began.
      const res = await api.get("/api/sessions", {
        project: detected.name,
        min_user_messages: 2,
        forever: "true",
        limit: Math.max(recentN * 5, 25),
      });
      recent = (Array.isArray(res) ? res : [])
        .sort((a, b) => lastActivityMs(b) - lastActivityMs(a))
        .slice(0, recentN);
    } catch {
      recent = null;
    }

    if (flags.json) return rawJson({ server, project: detected.name, cwd: detected.root, recent });

    const header = renderObject({
      server,
      project: detected.name,
      cwd: collapseHome(detected.root),
    });
    const blocks: string[] = [header];
    if (recent === null) {
      blocks.push("The server is not reachable. Set CLAUDE_ASSIST_SERVER or start it (cd apps/server && docker-compose up -d).");
    } else if (recent.length === 0) {
      blocks.push(`no prior sessions found for project "${detected.name}" — run \`${cli} home --all\` for the cross-project view`);
    } else {
      blocks.push(`recent[${recent.length}] in ${detected.name}:`);
      blocks.push(renderList("recent", recent, RECENT_SCHEMA));
    }
    blocks.push(
      renderHelp([
        `Run \`${cli} transcript <session-id>\` to read where you left off`,
        `Run \`${cli} search --query "<topic>" --project ${detected.name}\` to search within this repo`,
        `Run \`${cli} home --all\` for the cross-project (machines) view`,
        discoveryHelp(cli),
      ]),
    );
    return renderOutput(blocks);
  }

  // ── Global view (not in a repo, or --all) ──────────────────────────────
  let machines: any[] | null = null;
  try {
    const res = await api.get("/api/machines");
    machines = Array.isArray(res) ? res : [];
  } catch {
    machines = null;
  }

  if (flags.json) return rawJson({ server, machines });

  const blocks: string[] = [renderObject({ server })];
  if (machines === null) {
    blocks.push("The server is not reachable. Set CLAUDE_ASSIST_SERVER or start it (cd apps/server && docker-compose up -d).");
  } else if (machines.length === 0) {
    blocks.push("machines: none registered");
  } else {
    blocks.push(renderList("machines", machines, MACHINE_SCHEMA));
  }
  blocks.push(
    renderHelp([
      `Run \`${cli} transcript --after <ISO> --before <ISO>\` for "what did I work on <when>?" (the primary temporal tool)`,
      `Run \`${cli} search --query "<topic>" --project <repo>\` to find sessions by topic`,
      `Run \`${cli} activity --days 7\` to see when work happened`,
      discoveryHelp(cli),
    ]),
  );
  return renderOutput(blocks);
}
