import { runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import { DESCRIPTION, commandReferenceText } from "./reference.js";
import { cliInvocation } from "./invocation.js";
import { homeCommand } from "./commands/home.js";
import { searchCommand, SEARCH_HELP } from "./commands/search.js";
import { transcriptCommand, TRANSCRIPT_HELP } from "./commands/transcript.js";
import { grepCommand, GREP_HELP } from "./commands/grep.js";
import { detailsCommand, DETAILS_HELP } from "./commands/detail.js";
import { activityCommand, ACTIVITY_HELP } from "./commands/activity.js";
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

flags: --help, -v/--version, --json (raw output on most commands)

env: CLAUDE_ASSIST_SERVER (default http://localhost:2529)

examples:
  ${CLI}
  ${CLI} transcript --after 2026-06-22T00:00:00Z --before 2026-06-23T00:00:00Z
  ${CLI} search --query "auth refactor" --project claude-assist --min-user-messages 2
  ${CLI} search --tools mcp__plugin_slack --files-written routes.ts
  ${CLI} stats --days 7
`;

const HOME_HELP = `sessions-axi [home] [--all] [--project NAME] [--recent N] [--json]

  The no-arg view. Inside a git repo it leads with that repo's most recent
  sessions (ordered by last activity); otherwise it lists registered machines.

  --all            force the cross-project (machines) view even inside a repo
  --project NAME   override repo detection with an explicit project substring
  --recent N       how many recent sessions to show (default 5)
  --json           raw JSON`;

const COMMAND_HELP: Record<string, string> = {
  home: HOME_HELP,
  search: SEARCH_HELP,
  grep: GREP_HELP,
  transcript: TRANSCRIPT_HELP,
  details: DETAILS_HELP,
  activity: ACTIVITY_HELP,
  stats: STATS_HELP,
  machines: MACHINES_HELP,
  outlines: OUTLINES_HELP,
  sync: SYNC_HELP,
  share: SHARE_HELP,
};

const COMMANDS: Record<string, AxiCliCommand<undefined>> = {
  // Also exposed as a command so its flags can be passed (the bare invocation
  // hits the same handler via the `home` option below, but the SDK rejects
  // flags that precede a command).
  home: homeCommand,
  search: searchCommand,
  grep: grepCommand,
  transcript: transcriptCommand,
  details: detailsCommand,
  activity: activityCommand,
  stats: statsCommand,
  machines: machinesCommand,
  outlines: outlinesCommand,
  sync: syncCommand,
  share: shareCommand,
};

export async function main(argv?: string[]): Promise<void> {
  await runAxiCli<undefined>({
    description: DESCRIPTION,
    version: VERSION,
    ...(argv ? { argv } : {}),
    topLevelHelp: TOP_HELP,
    home: homeCommand,
    commands: COMMANDS,
    getCommandHelp: (command) => COMMAND_HELP[command],
  });
}
