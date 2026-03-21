---
name: google-account-setup
description: Set up Google Gmail accounts for email sync and triage. Use when user wants to add a Gmail account, connect their email, configure email sync settings, set up OAuth authorization, or add name aliases for commitment extraction. Triggers on phrases like "set up gmail", "add google account", "connect my email", "configure email sync".
---

# Google Account Setup

Interactive workflow to set up a Gmail account for sync and triage.

## Scripts

The `scripts/` directory contains executable wrappers for all API endpoints. **Always use these scripts** instead of raw curl commands.

All scripts default to `http://localhost:2529`. Override with `CLAUDE_ASSIST_SERVER` env var.

Available scripts: `create-account`, `get-account`, `update-account`, `add-alias`, `sync-emails`

## Workflow

### 1. Gather Account Details

Ask the user:

- **Identifier**: Short name like "work" or "personal"
- **Email**: Their Gmail address
- **Display name**: Their full name (optional)

### 2. Confirm Test User Setup

Before generating the OAuth URL, ask the user:

> "If this email is not part of your Google Cloud organization, please confirm you've added it as a test user at <https://console.cloud.google.com/auth/audience> (the app must also be set to 'External' rather than 'Internal'). Have you done this?"

Wait for confirmation before proceeding.

### 3. Create Account

```bash
scripts/create-account --identifier "<identifier>" --email "<email>" --display-name "<name>"
```

Response includes `authUrl` - present this to the user.

### 4. OAuth Authorization

Tell the user to open the `authUrl` in their browser and complete Google authorization. Wait for them to confirm completion.

### 5. Verify Credentials

```bash
scripts/get-account <id>
```

Confirm `has_credentials: true`. If false, offer to generate a new auth URL via `POST /google/accounts/<id>/reauth`.

### 6. Configure Settings

Ask the user:

- **email_sync_start_date**: "From what date should I sync emails? (YYYY-MM-DD format, or leave blank to sync all)"
- **email_label_prefix**: "What prefix for Gmail labels? (default: AI)"

Apply settings:

```bash
scripts/update-account <id> --sync-start-date "<date>" --label-prefix "<prefix>"
```

#### Triage System Instructions

The `email_triage_instructions` field lets you customize the AI triage behavior with account-specific rules. This plain text gets injected directly into Haiku's system prompt during email analysis.

**When to use:**

- **Name disambiguation**: When names in emails could be confused with the account owner
- **Custom extraction rules**: Account-specific patterns for commitments, action items, etc.
- **Context about roles/relationships**: Help the AI understand the user's work context

**Example - Name disambiguation:**

```bash
scripts/update-account <id> --triage-instructions "NAME DISAMBIGUATION:
- \"Christopher\" in emails refers to teammate Christopher Yamas, NOT the account owner
- The account owner goes by \"Chris\" or \"Chris Alfano\" only"
```

**Developing triage instructions:**

1. Start with common confusion points (similar names, nicknames)
2. Add context about the user's role and typical email interactions
3. Include any domain-specific terminology or patterns
4. Test by running triage on sample emails and reviewing results
5. Iterate based on extraction accuracy

### 7. Add Name Aliases

Ask the user what names refer to them (for commitment extraction). Only add names the user actually uses - don't assume variations.

**Important**: Names that refer to other people (teammates, etc.) should NOT be added as aliases. Instead, document these in `email_triage_instructions` for disambiguation.

For each alias:

```bash
scripts/add-alias <id> --alias "<name>"
```

### 8. Complete

Summarize the configured account and ask: "Would you like me to trigger an initial sync now?"

If yes, trigger a full sync:

```bash
scripts/sync-emails --account "<identifier>" --full
```

This will fetch untriaged inbox emails and queue them for triage.
