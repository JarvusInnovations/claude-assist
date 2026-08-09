/**
 * Single source of truth for the tool description and the command surface. Used
 * by the live home view (`commands/home.ts`), `--help` (`cli.ts`), and the
 * static SKILL.md generator (`skill.ts`), so the skill's command reference can
 * never drift from the CLI.
 */

export const DESCRIPTION =
  "Search and recall context from past Claude Code sessions across machines — " +
  "by topic (full-text search), by time period (cross-session transcripts), and by activity.";

export interface CommandRef {
  usage: string;
  summary: string;
}

export interface CommandGroup {
  group: string;
  commands: CommandRef[];
}

export const COMMAND_GROUPS: CommandGroup[] = [
  {
    group: "Recall",
    commands: [
      {
        usage:
          "search [--query TEXT] [--project PATH] [--days N | --since DATE --until DATE | --forever] [--tools a,b] [--files-read frag] [--files-written frag] [--machine ID] [--min-user-messages N] [--include-empty] [--limit N] [--offset N]",
        summary:
          "find sessions by topic/tool/file (tools & files are substring matches); defaults to last 30 days, hides subagent sessions at --min-user-messages 2",
      },
      {
        usage: "transcript <session-id> [--after DATE] [--before DATE] [--include-tools]",
        summary: "compact, token-efficient transcript of one session (optionally trimmed to a time window)",
      },
      {
        usage:
          "transcript --after DATE --before DATE [--group project|time] [--project PATH] [--min-user-messages N] [--include-tools]",
        summary: "cross-session transcript for a time range — the primary tool for \"what did I work on <when>?\"",
      },
      {
        usage: "grep <session-id> --tool Bash --match \"text\" [--in target|text|tool] [--context N]",
        summary: "find tool calls / text within a transcript — windowed matches + anchors",
      },
      {
        usage: "grep --tool Edit --match routes.ts [--project P] [--days N]",
        summary: "no id → cross-session tool-call discovery over the index",
      },
      {
        usage: "transcript <session-id> --around <uuid> [--before N] [--after M]",
        summary: "explore a variable range of messages around an anchor (the grep follow-up)",
      },
      { usage: "details <session-id> [--raw]", summary: "session metadata; --raw adds the parsed raw messages" },
      { usage: "activity [--days N]", summary: "when work happened — active time blocks per session (default 7 days)" },
    ],
  },
  {
    group: "Overview",
    commands: [
      { usage: "stats [--days N] [--machine ID]", summary: "usage statistics: top tools, models, tokens, per-machine counts" },
      { usage: "machines", summary: "list registered machines with sync status" },
    ],
  },
  {
    group: "Manage",
    commands: [
      { usage: "outlines [<session-id>...]", summary: "generate AI outlines for sessions missing/stale ones (needs the server's model invoker)" },
      { usage: "outlines progress", summary: "check background outline-generation progress" },
      { usage: "sync [--force]", summary: "trigger an immediate local session sync (--force re-parses all)" },
      { usage: "share <session-id>", summary: "mint a shareable auth code for a session transcript" },
    ],
  },
];

/**
 * The full grouped command reference (usage + one-line summary per command) as
 * plain text — the canonical surface carried by `sessions-axi --help`. Derived
 * from `COMMAND_GROUPS`, the same source the SKILL.md reference splices from.
 */
export function commandReferenceText(): string {
  return COMMAND_GROUPS.map((g) => {
    const items = g.commands.map((c) => `  ${c.usage}\n      ${c.summary}`).join("\n");
    return `${g.group}:\n${items}`;
  }).join("\n\n");
}

/** The generic "how to explore the CLI" discovery pointer for `help[]` blocks. */
export function discoveryHelp(invocation: string): string {
  return `Run \`${invocation} --help\` for the full command list, or \`${invocation} <command> --help\` for usage on any command`;
}
