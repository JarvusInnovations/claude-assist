import { runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import { formatError } from "../../../core/src/axi/errors.js";
import { withJsonOut } from "../../../core/src/axi/json-out.js";
import { DESCRIPTION, commandReferenceText } from "./reference.js";
import { cliInvocation } from "./invocation.js";
import { homeCommand } from "./commands/home.js";
import { searchCommand, SEARCH_HELP } from "./commands/search.js";
import { transcriptCommand, TRANSCRIPT_HELP } from "./commands/transcript.js";
import { grepCommand, GREP_HELP } from "./commands/grep.js";
import { detailsCommand, DETAILS_HELP } from "./commands/detail.js";
import { activityCommand, ACTIVITY_HELP } from "./commands/activity.js";
import { engagementCommand, ENGAGEMENT_HELP } from "./commands/engagement.js";
import { statsCommand, STATS_HELP } from "./commands/stats.js";
import { machinesCommand, MACHINES_HELP } from "./commands/machines.js";
import { outlinesCommand, OUTLINES_HELP, syncCommand, SYNC_HELP, shareCommand, SHARE_HELP } from "./commands/manage.js";

// Injected at build time by scripts/build-cli.ts (from `git describe`).
declare const __AXI_VERSION__: string;
const VERSION = typeof __AXI_VERSION__ === "string" ? __AXI_VERSION__ : "dev";

const CLI = cliInvocation();
const TOP_HELP = `usage: ${CLI} [command] [args] [flags]
       ${CLI}                 # no args → home (recent activity + next steps)

commands:

${commandReferenceText()}

flags: --help, -v/--version, --json-out[=path] (full JSON to a file; stdout stays TOON)

env: CLAUDE_ASSIST_SERVER (default http://localhost:2529)

examples:
  ${CLI}
  ${CLI} transcript --after 2026-06-22T00:00:00Z --before 2026-06-23T00:00:00Z
  ${CLI} search --query "auth refactor" --project claude-assist --min-user-messages 2
  ${CLI} search --tools mcp__plugin_slack --files-written routes.ts
  ${CLI} stats --days 7
`;

const HOME_HELP = `sessions-axi [home] [--all] [--project NAME] [--recent N] [--json-out[=path]]

  The no-arg view. Inside a git repo it leads with that repo's most recent
  sessions (ordered by last activity); otherwise it lists registered machines.

  --all            force the cross-project (machines) view even inside a repo
  --project NAME   override repo detection with an explicit project substring
  --recent N       how many recent sessions to show (default 5)
  --json-out[=path]  write the full JSON to a file (bare: an owner-only temp
                     file); stdout stays this view`;

export const COMMAND_HELP: Record<string, string> = {
  home: HOME_HELP,
  search: SEARCH_HELP,
  grep: GREP_HELP,
  transcript: TRANSCRIPT_HELP,
  details: DETAILS_HELP,
  activity: ACTIVITY_HELP,
  engagement: ENGAGEMENT_HELP,
  stats: STATS_HELP,
  machines: MACHINES_HELP,
  outlines: OUTLINES_HELP,
  sync: SYNC_HELP,
  share: SHARE_HELP,
};

/**
 * Every handler is wrapped so a requested `--json-out` export is written after
 * the view is built (specs/behaviors/axi-cli-arguments-and-export.md).
 */
const HANDLERS: Record<string, (args: string[]) => Promise<string>> = {
  // Also exposed as a command so its flags can be passed (the bare invocation
  // hits the same handler via the `home` option below, but the SDK rejects
  // flags that precede a command).
  home: homeCommand,
  search: searchCommand,
  grep: grepCommand,
  transcript: transcriptCommand,
  details: detailsCommand,
  activity: activityCommand,
  engagement: engagementCommand,
  stats: statsCommand,
  machines: machinesCommand,
  outlines: outlinesCommand,
  sync: syncCommand,
  share: shareCommand,
};

export const COMMANDS: Record<string, AxiCliCommand<undefined>> = Object.fromEntries(
  Object.entries(HANDLERS).map(([name, handler]) => [name, withJsonOut(handler)]),
);

export async function main(argv?: string[]): Promise<void> {
  await runAxiCli<undefined>({
    description: DESCRIPTION,
    version: VERSION,
    ...(argv ? { argv } : {}),
    topLevelHelp: TOP_HELP,
    home: COMMANDS.home!,
    commands: COMMANDS,
    formatError,
    getCommandHelp: (command) => COMMAND_HELP[command],
  });
}
