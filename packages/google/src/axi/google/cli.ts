import { runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import { DESCRIPTION, commandReferenceText } from "./reference.js";
import { cliInvocation } from "../invocation.js";
import { homeCommand } from "./commands/home.js";
import { accountsCommand, ACCOUNTS_HELP, accountCommand } from "./commands/accounts.js";
import { aliasesCommand, ALIASES_HELP } from "./commands/aliases.js";

declare const __AXI_VERSION__: string;
const VERSION = typeof __AXI_VERSION__ === "string" ? __AXI_VERSION__ : "dev";

const CLI = cliInvocation();
const TOP_HELP = `usage: ${CLI} [command] [args] [flags]
       ${CLI}                 # no args → home (accounts + auth status)

commands:

${commandReferenceText()}

flags: --help, -v/--version, --json (raw output)

env: CLAUDE_ASSIST_SERVER (default http://localhost:2529)

examples:
  ${CLI}
  ${CLI} account create --identifier chris --email chris@example.com
  ${CLI} account reauth 1
  ${CLI} aliases add 1 --alias "Chris A"
`;

const COMMAND_HELP: Record<string, string> = {
  accounts: ACCOUNTS_HELP,
  account: `google-axi account get|create|update|reauth|delete <id> [...]\n\n  Manage a single Google account. See \`--help\` for the field flags on each verb.`,
  aliases: ALIASES_HELP,
};

const COMMANDS: Record<string, AxiCliCommand<undefined>> = {
  accounts: accountsCommand,
  account: accountCommand,
  aliases: aliasesCommand,
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
