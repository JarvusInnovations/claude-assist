import { AxiError } from "axi-sdk-js";
import { api } from "../client.js";
import { parseArgs, rawJson } from "../args.js";
import { renderList, renderOutput, renderHelp, field, custom, truncate, formatRelativeTime, type FieldDef } from "../toon.js";
import { cliInvocation } from "../invocation.js";

export const GREP_HELP = `sessions-axi grep <session-id> [flags]      # within one transcript → windowed matches
sessions-axi grep [flags]                   # no id → cross-session tool-call discovery

  Find tool calls (by name/target) or message text inside transcripts. Each hit
  returns a window of surrounding messages and anchors you can explore from with
  \`transcript <id> --around <uuid> --before N --after M\`.

  --tool SUBSTR        tool name contains SUBSTR (e.g. Bash, mcp__slack)
  --match SUBSTR       content contains SUBSTR
  --in target|text|tool|any   where --match applies (default any; cross-session: target|tool)
  --context N          messages of context each side of a per-session hit (default 1)
  --limit N            max matches (default 10 per-session / 20 cross-session)
  --include-sidechain  include subagent messages (excluded by default)
  --after <uuid>       per-session: resume scanning after this message
  --before <uuid>      per-session: stop scanning at this message
  --project PATH       cross-session: filter by project path (substring)
  --days N             cross-session: only the last N days
  --json               raw API JSON

  At least one of --tool / --match is required.`;

const CROSS_SCHEMA: FieldDef[] = [
  field("session_id", "session"),
  custom("title", (r) => r.title ?? null),
  custom("when", (r) => formatRelativeTime(r.ts)),
  field("tool"),
  truncate("target", 60),
  field("anchor"),
];

export async function grepCommand(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json", "include-sidechain"]);
  const id = positionals[0];

  if (!flags.tool && !flags.match) {
    throw new AxiError("Provide --tool and/or --match", "VALIDATION_ERROR", [GREP_HELP]);
  }
  return id ? grepSession(id, flags) : grepCross(flags);
}

async function grepSession(id: string, flags: Record<string, string | boolean>): Promise<string> {
  const cli = cliInvocation();
  const query: Record<string, string> = {};
  if (typeof flags.tool === "string") query.tool = flags.tool;
  if (typeof flags.match === "string") query.match = flags.match;
  if (typeof flags.in === "string") query.in = flags.in;
  if (typeof flags.context === "string") query.context = flags.context;
  if (typeof flags.limit === "string") query.limit = flags.limit;
  if (typeof flags.after === "string") query.after_uuid = flags.after;
  if (typeof flags.before === "string") query.before_uuid = flags.before;
  if (flags["include-sidechain"]) query.include_sidechain = "true";

  const res = await api.get(`/api/sessions/${encodeURIComponent(id)}/find`, query);
  if (flags.json) return rawJson(res);

  const matches: any[] = res?.matches ?? [];
  if (matches.length === 0) return "grep: 0 matches in this session";

  const blocks: string[] = [`count: ${matches.length} match${matches.length === 1 ? "" : "es"}`];
  matches.forEach((m, i) => {
    const w = m.window;
    const label = m.tool ? `${m.tool}${m.target ? ` · ${m.target.slice(0, 60)}` : ""}` : "text";
    blocks.push(
      [
        ``,
        `match ${i + 1} — ${label} — msg ${m.index} · ${formatRelativeTime(m.ts)}`,
        ...w.lines,
        `  ↕ ${w.more_before} before · ${w.more_after} after${w.truncated ? " · window truncated" : ""}`,
        `  explore: ${cli} transcript ${id} --around ${w.head} --before 20  |  ${cli} transcript ${id} --around ${w.tail} --after 20`,
      ].join("\n"),
    );
  });

  const last = matches[matches.length - 1];
  blocks.push(renderHelp([`Run \`${cli} grep ${id} … --after ${last.anchor}\` for the next matches`]));
  return renderOutput(blocks);
}

async function grepCross(flags: Record<string, string | boolean>): Promise<string> {
  const cli = cliInvocation();
  if (flags.in === "text") {
    throw new AxiError("Cross-session text search is not indexed", "VALIDATION_ERROR", [
      `Use \`${cli} search --query "…"\` to find sessions, then \`${cli} grep <id> --match "…" --in text\``,
    ]);
  }
  const query: Record<string, string> = {};
  if (typeof flags.tool === "string") query.tool = flags.tool;
  if (typeof flags.match === "string") query.match = flags.match;
  if (typeof flags.in === "string") query.in = flags.in;
  if (typeof flags.project === "string") query.project = flags.project;
  if (typeof flags.days === "string") query.days = flags.days;
  if (typeof flags.limit === "string") query.limit = flags.limit;
  if (flags["include-sidechain"]) query.include_sidechain = "true";

  const rows = await api.get("/api/sessions/find", query);
  if (flags.json) return rawJson(rows);
  if (!Array.isArray(rows) || rows.length === 0) return "grep: 0 matching tool calls found";

  return renderOutput([
    `count: ${rows.length}`,
    renderList("matches", rows, CROSS_SCHEMA),
    renderHelp([
      `Run \`${cli} transcript <session> --around <anchor> --after 20\` to read around a match`,
      `Run \`${cli} grep <session> --tool … --match …\` to window matches within one session`,
    ]),
  ]);
}
