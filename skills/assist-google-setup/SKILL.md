---
name: assist-google-setup
description: >-
  Set up Google accounts for Gmail sync and triage. Use when user wants to add a Gmail
  account, connect their email, configure email sync settings, set up OAuth authorization,
  or add name aliases for commitment extraction. Triggers on phrases like "set up gmail",
  "add google account", "connect my email", "configure email sync", "authorize gmail".
---

# assist-google-setup

Set up and manage Google accounts (OAuth) via the bundled **`google-axi`** CLI — a script
in this skill's `scripts/` directory (not on `PATH`). This is the shared Google account
foundation that **`assist-gmail`** (and future Google-service skills) build on. Invoke it
by its path relative to this skill's base directory:

```bash
scripts/google-axi                     # home: accounts + auth status
scripts/google-axi --help              # full command list
scripts/google-axi <command> --help    # usage for any command
```

Output is [TOON](https://toonformat.dev); pass `--json` for raw API JSON. The server
defaults to `http://localhost:2529` (override with `CLAUDE_ASSIST_SERVER`).

## Connecting an account (OAuth flow)

1. **Create** the account — returns an `authUrl`:

   ```bash
   scripts/google-axi account create --identifier chris --email chris@example.com
   ```

2. **Authorize**: give the `authUrl` to the user to open in a browser and grant access.
   The OAuth callback completes authorization server-side; the account then has
   credentials and can sync.
3. **Verify**: `scripts/google-axi accounts` — the account should show `authed: yes`.

`identifier` is a short stable handle (e.g. `chris`) used everywhere else (e.g.
`gmail-axi emails --account chris`). Use `account reauth <id>` to mint a fresh `authUrl`
if tokens are revoked or expired.

## Name aliases

Aliases disambiguate who email is from/to and who commitments refer to. By default a new
alias refers to the account owner; for someone else, pass `--not-owner --refers-to "<name>"`.

## Commands

<!-- BEGIN GENERATED: command-reference -->

### Accounts

- `scripts/google-axi accounts` — list all Google accounts with credential + sync/triage status
- `scripts/google-axi account get <id>` — full account detail including settings
- `scripts/google-axi account create --identifier ID --email EMAIL [--name NAME]` — create an account and return an OAuth authUrl for the user to authorize
- `scripts/google-axi account update <id> [--name TEXT] [--primary] [--triage-instructions TEXT] [--label-prefix TEXT] [--label-prefix-todo TEXT] [--sync-start-date DATE]` — update display name / primary flag / triage + label settings
- `scripts/google-axi account reauth <id>` — mint a fresh OAuth authUrl for an existing account
- `scripts/google-axi account delete <id>` — revoke tokens and delete the account (cascades to its emails/aliases)

### Aliases

- `scripts/google-axi aliases <account-id>` — list name aliases used for commitment/sender disambiguation
- `scripts/google-axi aliases add <account-id> --alias NAME [--not-owner] [--refers-to NAME] [--notes TEXT]` — add a name alias (default marks it as referring to the account owner)
- `scripts/google-axi aliases remove <account-id> <alias-id>` — delete a name alias

<!-- END GENERATED: command-reference -->

## Notes

- Settings like triage instructions and Gmail label prefixes are edited with
  `account update <id>` (e.g. `--triage-instructions`, `--label-prefix`).
- Deleting an account revokes its OAuth tokens and cascades to its emails and aliases.
- Once an account is authorized, use the **`assist-gmail`** skill (`gmail-axi`) to sync,
  search, and triage its mail.
