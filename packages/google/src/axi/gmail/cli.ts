import { runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import { DESCRIPTION, commandReferenceText } from "./reference.js";
import { cliInvocation } from "../invocation.js";
import { homeCommand } from "./commands/home.js";
import { emailsCommand, EMAILS_HELP, emailCommand } from "./commands/emails.js";
import { statsCommand, STATS_HELP } from "./commands/stats.js";
import {
  syncCommand,
  SYNC_HELP,
  triageCommand,
  TRIAGE_HELP,
  bulkActionCommand,
  BULK_ACTION_HELP,
} from "./commands/pipeline.js";

declare const __AXI_VERSION__: string;
const VERSION = typeof __AXI_VERSION__ === "string" ? __AXI_VERSION__ : "dev";

const CLI = cliInvocation();
const TOP_HELP = `usage: ${CLI} [command] [args] [flags]
       ${CLI}                 # no args → home (inbox pipeline + next steps)

commands:

${commandReferenceText()}

flags: --help, -v/--version, --json (raw output)

env: CLAUDE_ASSIST_SERVER (default http://localhost:2529)

examples:
  ${CLI}
  ${CLI} emails --status new --limit 20
  ${CLI} triage --limit 25
  ${CLI} email 12345
`;

const COMMAND_HELP: Record<string, string> = {
  emails: EMAILS_HELP,
  email: `gmail-axi email <id> [--json]\n\n  Full detail for one email including its AI analysis.`,
  stats: STATS_HELP,
  sync: SYNC_HELP,
  triage: TRIAGE_HELP,
  "bulk-action": BULK_ACTION_HELP,
};

const COMMANDS: Record<string, AxiCliCommand<undefined>> = {
  emails: emailsCommand,
  email: emailCommand,
  stats: statsCommand,
  sync: syncCommand,
  triage: triageCommand,
  "bulk-action": bulkActionCommand,
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
