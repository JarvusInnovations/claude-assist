---
name: google-account-setup
description: Set up Google Gmail accounts for email sync and triage. Use when user wants to add a Gmail account, connect their email, configure email sync settings, set up OAuth authorization, or add name aliases for commitment extraction. Triggers on phrases like "set up gmail", "add google account", "connect my email", "configure email sync".
---

# Google Account Setup

Interactive workflow to set up a Gmail account for sync and triage.

## Workflow

### 1. Gather Account Details

Ask the user:

- **Identifier**: Short name like "work" or "personal"
- **Email**: Their Gmail address
- **Display name**: Their full name (optional)

### 2. Create Account

```bash
curl -X POST http://localhost:3000/google/accounts \
  -H "Content-Type: application/json" \
  -d '{"identifier": "<identifier>", "email": "<email>", "display_name": "<name>"}'
```

Response includes `authUrl` - present this to the user.

### 3. OAuth Authorization

Tell the user to open the `authUrl` in their browser and complete Google authorization. Wait for them to confirm completion.

### 4. Verify Credentials

```bash
curl http://localhost:3000/google/accounts/<id>
```

Confirm `has_credentials: true`. If false, offer to generate a new auth URL via `POST /google/accounts/<id>/reauth`.

### 5. Configure Settings

Ask the user:

- **sync_start_date**: "From what date should I sync emails? (YYYY-MM-DD format, or leave blank to sync all)"
- **label_prefix_tracking**: "What prefix for Gmail labels? (default: AI)"

Apply settings:

```bash
curl -X PATCH http://localhost:3000/google/accounts/<id> \
  -H "Content-Type: application/json" \
  -d '{"sync_start_date": "<date>", "label_prefix_tracking": "<prefix>"}'
```

### 6. Add Name Aliases

Ask the user what names refer to them (for commitment extraction). Examples: "Chris", "Chris Alfano", "Christopher".

For each alias:

```bash
curl -X POST http://localhost:3000/google/accounts/<id>/aliases \
  -H "Content-Type: application/json" \
  -d '{"alias": "<name>", "is_owner": true}'
```

### 7. Complete

Summarize the configured account and ask if they want to trigger an initial sync.
