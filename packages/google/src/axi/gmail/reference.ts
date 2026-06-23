/**
 * Single source of truth for the gmail-axi description and command surface.
 * Consumed by the home view, `--help`, and the SKILL.md generator (skill.ts).
 */

export const DESCRIPTION =
  "Manage Gmail sync, triage, and analysis — search the inbox, check triage progress, " +
  "trigger sync/triage, and review per-message AI analysis.";

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
    group: "Inbox",
    commands: [
      {
        usage:
          "emails [--account ID] [--status discovered|new|triaged] [--type a,b] [--search TEXT] [--with NAME] [--days N] [--limit N] [--offset N]",
        summary: "search/filter emails (most recent first); --type matches analysis message_type, --with matches from/to",
      },
      { usage: "email <id>", summary: "full detail for one email including its AI analysis" },
      { usage: "stats [--account ID] [--days N]", summary: "counts by workflow status, message type, and sender type" },
    ],
  },
  {
    group: "Pipeline",
    commands: [
      { usage: "sync [--account ID] [--full]", summary: "trigger Gmail sync (async; --full re-reads history). Watch via accounts" },
      { usage: "triage [<email-id>] [--account ID] [--limit N] [--force]", summary: "triage one email (id) or a batch of pending ones (needs ANTHROPIC_API_KEY)" },
      { usage: "triage progress", summary: "discovered/new/triaged/error counts for the last 7 days" },
      { usage: "bulk-action <action> <email-id>...", summary: "run a bulk action over emails (e.g. force-retriage)" },
    ],
  },
];

export function commandReferenceText(): string {
  return COMMAND_GROUPS.map((g) => {
    const items = g.commands.map((c) => `  ${c.usage}\n      ${c.summary}`).join("\n");
    return `${g.group}:\n${items}`;
  }).join("\n\n");
}

export function discoveryHelp(invocation: string): string {
  return `Run \`${invocation} --help\` for the full command list, or \`${invocation} <command> --help\` for usage on any command`;
}
