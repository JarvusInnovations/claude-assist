import { runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import { DESCRIPTION, commandReferenceText } from "./reference.js";
import { cliInvocation } from "./invocation.js";
import { homeCommand, HOME_HELP } from "./commands/home.js";
import { entriesCommand, ENTRIES_HELP } from "./commands/entries.js";
import { daysCommand, DAYS_HELP } from "./commands/days.js";
import { inventoryCommand, INVENTORY_HELP } from "./commands/inventory.js";
import { prepCommand, PREP_HELP } from "./commands/prep.js";
import { expenditureCommand, EXPENDITURE_HELP } from "./commands/expenditures.js";
import { weighInsCommand, weightCommand, WEIGH_INS_HELP, WEIGHT_HELP } from "./commands/weigh-ins.js";
import { receiptsCommand, RECEIPTS_HELP } from "./commands/receipts.js";
import { recipesCommand, RECIPES_HELP } from "./commands/recipes.js";
import { productsCommand, PRODUCTS_HELP } from "./commands/products.js";
import { lexiconCommand, LEXICON_HELP } from "./commands/lexicon.js";

// Injected at build time by scripts/build-cli.ts (from `git describe`).
declare const __AXI_VERSION__: string;
const VERSION = typeof __AXI_VERSION__ === "string" ? __AXI_VERSION__ : "dev";

const CLI = cliInvocation();
const TOP_HELP = `usage: ${CLI} [group] [subcommand] [args] [flags]
       ${CLI}                 # no args → home (today's totals + eat-first + questions)

commands:

${commandReferenceText()}

flags: --help, -v/--version, --json (raw output on most commands)

env: CLAUDE_ASSIST_SERVER (default http://localhost:2529)

examples:
  ${CLI}
  ${CLI} entries log "chicken and rice bowl"
  ${CLI} entries patch 01J… --multiplier 0.5
  ${CLI} inventory remark "opened the oat milk"
  ${CLI} receipts scan ./receipt-front.jpg ./receipt-back.jpg --store "Corner Market"
`;

const COMMAND_HELP: Record<string, string> = {
  home: HOME_HELP,
  entries: ENTRIES_HELP,
  days: DAYS_HELP,
  inventory: INVENTORY_HELP,
  expenditure: EXPENDITURE_HELP,
  "weigh-ins": WEIGH_INS_HELP,
  weight: WEIGHT_HELP,
  receipts: RECEIPTS_HELP,
  recipes: RECIPES_HELP,
  products: PRODUCTS_HELP,
  lexicon: LEXICON_HELP,
  prep: PREP_HELP,
};

const COMMANDS: Record<string, AxiCliCommand<undefined>> = {
  home: (args) => homeCommand(args),
  entries: (args) => entriesCommand(args),
  days: (args) => daysCommand(args),
  inventory: (args) => inventoryCommand(args),
  expenditure: (args) => expenditureCommand(args),
  "weigh-ins": (args) => weighInsCommand(args),
  weight: (args) => weightCommand(args),
  receipts: (args) => receiptsCommand(args),
  recipes: (args) => recipesCommand(args),
  products: (args) => productsCommand(args),
  lexicon: (args) => lexiconCommand(args),
  prep: (args) => prepCommand(args),
};

export async function main(argv?: string[]): Promise<void> {
  await runAxiCli<undefined>({
    description: DESCRIPTION,
    version: VERSION,
    ...(argv ? { argv } : {}),
    topLevelHelp: TOP_HELP,
    home: (args) => homeCommand(args),
    commands: COMMANDS,
    getCommandHelp: (command) => COMMAND_HELP[command],
  });
}
