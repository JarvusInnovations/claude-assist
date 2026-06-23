/**
 * Single source of truth for the google-axi description and command surface.
 * google-axi manages Google accounts + OAuth + name aliases — the shared
 * foundation that assist-gmail (and future Google-service skills) build on.
 */

export const DESCRIPTION =
  "Set up and manage Google accounts (OAuth) for Gmail sync and triage — create/list " +
  "accounts, complete authorization, edit settings, and manage name aliases.";

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
    group: "Accounts",
    commands: [
      { usage: "accounts", summary: "list all Google accounts with credential + sync/triage status" },
      { usage: "account get <id>", summary: "full account detail including settings" },
      {
        usage: "account create --identifier ID --email EMAIL [--name NAME]",
        summary: "create an account and return an OAuth authUrl for the user to authorize",
      },
      {
        usage:
          "account update <id> [--name TEXT] [--primary] [--triage-instructions TEXT] [--label-prefix TEXT] [--label-prefix-todo TEXT] [--sync-start-date DATE]",
        summary: "update display name / primary flag / triage + label settings",
      },
      { usage: "account reauth <id>", summary: "mint a fresh OAuth authUrl for an existing account" },
      { usage: "account delete <id>", summary: "revoke tokens and delete the account (cascades to its emails/aliases)" },
    ],
  },
  {
    group: "Aliases",
    commands: [
      { usage: "aliases <account-id>", summary: "list name aliases used for commitment/sender disambiguation" },
      {
        usage: "aliases add <account-id> --alias NAME [--not-owner] [--refers-to NAME] [--notes TEXT]",
        summary: "add a name alias (default marks it as referring to the account owner)",
      },
      { usage: "aliases remove <account-id> <alias-id>", summary: "delete a name alias" },
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
