---
name: assist-gmail
description: >-
  Manage Gmail email sync, triage, and analysis workflows. Use when user wants to sync
  emails, triage inbox, check email analysis results, view email statistics, manage the
  email processing pipeline, find newsletters, check pending emails, or understand email
  workflow status. Triggers on phrases like "sync my emails", "triage inbox", "email
  status", "check newsletters", "email analysis", "what emails do I have", "pending
  emails", "unsubscribe from newsletters".
---

# assist-gmail

Search, triage, and analyze synced Gmail via the bundled **`gmail-axi`** CLI — a script
in this skill's `scripts/` directory (not on `PATH`). Invoke it by its path relative to
this skill's base directory:

```bash
scripts/gmail-axi                      # home: inbox pipeline + next steps
scripts/gmail-axi --help               # full command list
scripts/gmail-axi <command> --help     # usage for any command
```

Output is [TOON](https://toonformat.dev); pass `--json` for raw API JSON. The server
defaults to `http://localhost:2529` (override with `CLAUDE_ASSIST_SERVER`). Account
setup, OAuth, and name aliases live in the separate **`assist-google-setup`** skill
(`google-axi`).

## Workflow model

Emails flow through workflow statuses: **discovered** → **new** → **triaged**. Sync pulls
new mail; triage runs AI analysis (message type, sender type, summaries) and applies Gmail
labels. Triage requires `ANTHROPIC_API_KEY` on the server.

- **"What's in my inbox / what needs attention?"** → `emails --status new`
- **"Triage my inbox"** → `triage` (batch), then `triage progress`
- **"Pull new mail"** → `sync` (async; watch with `google-axi accounts`)
- **"Email stats / how many newsletters?"** → `stats`, or `emails --type newsletter`

Sync and batch triage are **asynchronous** — they return immediately. Poll
`triage progress` or `google-axi accounts` for completion rather than assuming it's done.

## Commands

<!-- BEGIN GENERATED: command-reference -->

### Inbox

- `scripts/gmail-axi emails [--account ID] [--status discovered|new|triaged] [--type a,b] [--search TEXT] [--with NAME] [--days N] [--limit N] [--offset N]` — search/filter emails (most recent first); --type matches analysis message_type, --with matches from/to
- `scripts/gmail-axi email <id>` — full detail for one email including its AI analysis
- `scripts/gmail-axi stats [--account ID] [--days N]` — counts by workflow status, message type, and sender type

### Pipeline

- `scripts/gmail-axi sync [--account ID] [--full]` — trigger Gmail sync (async; --full re-reads history). Watch via accounts
- `scripts/gmail-axi triage [<email-id>] [--account ID] [--limit N] [--force]` — triage one email (id) or a batch of pending ones (needs ANTHROPIC_API_KEY)
- `scripts/gmail-axi triage progress` — discovered/new/triaged/error counts for the last 7 days
- `scripts/gmail-axi bulk-action <action> <email-id>...` — run a bulk action over emails (e.g. force-retriage)

### Actions

- `scripts/gmail-axi digest` — preview the daily confirm-to-execute digest (staged actions grouped by section)
- `scripts/gmail-axi execute <email-id>... [--no-labels] [--no-actions]` — apply staged plans: AI/* + TODO/* labels and archive/spam moves (deterministic; spam is quarantined, never deleted)

<!-- END GENERATED: command-reference -->

## Tips

- Scope to one account with `--account <identifier>` when multiple are configured.
- `--type` matches the AI `message_type` (e.g. `newsletter`, `alert`, `personal`); combine
  comma-separated values for OR matching.
- `--with <name>` finds mail to/from a person (substring over from/to).
- Use `email <id> --json` to see the full AI `analysis` object for a message.
