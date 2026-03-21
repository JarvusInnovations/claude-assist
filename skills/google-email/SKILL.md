---
name: google-email
description: Manage Gmail email sync, triage, and analysis workflows. Use when user wants to sync emails, triage inbox, check email analysis results, view email statistics, manage the email processing pipeline, find newsletters, check pending emails, or understand email workflow status. Triggers on phrases like "sync my emails", "triage inbox", "email status", "check newsletters", "email analysis", "what emails do I have", "pending emails", "unsubscribe from newsletters".
---

# Google Email Management

Manage Gmail sync, AI-powered triage, and email analysis workflows.

## Prerequisites

Use the `google-account-setup` skill to configure Gmail accounts before using these workflows. Accounts must have OAuth credentials (`has_credentials: true`) for sync and triage to work.

## Scripts

The `scripts/` directory contains executable wrappers for all API endpoints. **Always use these scripts** instead of raw curl commands.

Run scripts using their full path relative to this skill's base directory (provided when the skill is loaded). For example: `<skill-base-dir>/scripts/accounts`

All scripts default to `http://localhost:2529`. Override with `CLAUDE_ASSIST_SERVER` env var.

Available scripts: `accounts`, `sync-emails`, `emails`, `email`, `email-stats`, `triage`, `triage-progress`

## Workflow States

Emails progress through a three-state pipeline:

1. **discovered** - Listed from Gmail API but content not yet fetched
2. **new** - Full content fetched, ready for AI triage
3. **triaged** - Analysis complete with EmailAnalysis populated

## Automated Schedule

The server runs these scheduled tasks automatically:

- **Incremental sync**: Every 5 minutes (fetches new emails)
- **Batch triage**: Every 5 minutes (requires `ANTHROPIC_API_KEY`)
- **Full sync**: Daily at 4 AM (complete re-sync for consistency)

## Email Analysis Structure

Each triaged email has an `analysis` field with this structure:

```typescript
interface EmailAnalysis {
  overview: string;                    // 1-2 sentence summary
  mentioned_people: string[];          // Names mentioned in email
  mentioned_organizations: string[];   // Organizations mentioned
  potential_action_items: string[];    // Action items for recipient
  sender_type: 'automated' | 'human';
  message_type: 'spam' | 'newsletter' | 'alert' | 'group' | 'personal';
  unsubscribe_link: string | null;     // Extracted unsubscribe URL
  rationale: string;                   // Explanation of classification
}
```

### Sender Type

- **automated**: System-generated, no human composed (receipts, alerts, notifications, auto-responders)
- **human**: Human composed, regardless of sending tool (CRM, ticketing system, etc.)

### Message Type

- **spam**: Unsolicited email confidently recognized as spam (phishing, scams, suspicious cold outreach). NOT newsletters.
- **newsletter**: Any email with an unsubscribe link (periodic updates, marketing, announcements). Legitimacy determined later.
- **alert**: System notifications, transactional (receipts, confirmations, calendar). No unsubscribe link typical.
- **group**: Sent to mailing list or large recipient list, not individually addressed. Check TO/CC fields.
- **personal**: Direct person-to-person, individually addressed in TO with small/relevant CC.

### Multi-Turn Analysis

The AI triage uses a conversational approach:

1. **Turn 1**: Initial analysis with automatic JSON retry on parse error
2. **Turn 2** (conditional): If classified as newsletter but missing unsubscribe link, HTML body is examined to extract the link

## API Endpoints

### Check Account Status

```bash
scripts/accounts
```

Returns accounts with `email_sync_status` and `email_triage_status` showing real-time progress.

### Sync Operations

```bash
# Incremental sync all accounts
scripts/sync-emails

# Full sync specific account
scripts/sync-emails --account personal --full
```

### Query Emails

```bash
# Filter by workflow status and message type
scripts/emails --status triaged --type newsletter --days 7

# Get single email with full details
scripts/email 123

# Get statistics
scripts/email-stats --days 7
```

**Query Parameters:**

- `account` - Filter by account identifier (e.g., "personal", "work")
- `workflow_status` - Filter by state: `discovered`, `new`, `triaged`
- `message_type` - Filter by classification: `spam`, `newsletter`, `alert`, `group`, `personal`
- `search` - Full-text search on email content
- `days` - Look back N days (default: 30)
- `limit` - Results per page (default: 50, max: 100)
- `offset` - Pagination offset

### Triage Operations

```bash
# Batch triage all 'new' emails
scripts/triage

# Triage single email
scripts/triage 123

# Check progress
scripts/triage-progress
```

## Common Workflows

### 1. Initial Sync After Account Setup

```bash
scripts/sync-emails --account personal --full
scripts/accounts  # monitor progress
```

### 2. Check Inbox Status

```bash
scripts/email-stats --days 7
scripts/triage-progress
```

### 3. Find Newsletters for Review

```bash
scripts/emails --type newsletter --status triaged --days 7
```

### 4. Find Personal Emails Needing Attention

```bash
scripts/emails --type personal --status triaged --days 3
```

### 5. Find Emails with Action Items

Query triaged emails and filter by those with `potential_action_items` in the analysis:

```bash
scripts/emails --status triaged --days 7
```

Then filter results where `analysis.potential_action_items` is non-empty.

### 6. Manual Triage Trigger

```bash
scripts/triage          # all pending
scripts/triage 123      # specific email
```
