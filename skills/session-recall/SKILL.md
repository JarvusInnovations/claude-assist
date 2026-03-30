---
name: session-recall
description: >-
  Search past Claude sessions for context. Use when asked "where did we leave off?",
  "what did we discuss about X?", "find a previous conversation", or when needing context
  from earlier work across machines. Also use for time-based queries like "what did I work
  on today/yesterday/this week/this morning?", "what happened on Monday?", "show me
  everything from last Tuesday", "give me a standup summary", or any request to review
  work across a time period or across projects.
---

# Session Recall

Search and retrieve context from past Claude Code sessions across multiple machines.

## Important Behavior

### Choosing the Right Tool: Search vs Transcript

This skill has two primary retrieval modes. **Choosing correctly is critical.**

| User intent | Tool | Why |
|---|---|---|
| Find sessions **about a topic** ("what did we discuss about auth?") | `scripts/search` | Full-text search across outlines, prompts, tools, files |
| Review **what happened during a time period** ("what did I do today?", "show me yesterday's work") | `scripts/transcript --after ... --before ...` (no session ID) | Cross-session temporal transcript |
| Check **when** work happened ("when was I active?", "how much time on X?") | `scripts/activity --days N` | Activity time ranges per session |
| Read the **content of a specific session** | `scripts/transcript <session-id>` | Per-session transcript |
| Read part of a session within a **time window** | `scripts/transcript <session-id> --after ... --before ...` | Per-session filtered transcript |

**Key rule**: If the user's question is about a **time period** (today, yesterday, this morning, last week, Monday, a date range), use the **cross-session transcript** endpoint — not search. Search finds sessions by topic keywords; the transcript endpoint reconstructs what actually happened during a time window.

### Recognizing Temporal Queries

Use the **cross-session transcript** (no session ID, with `--after`/`--before`) when the user asks anything like:

- "What did I work on today/yesterday/this week?"
- "What happened on Monday?"
- "Show me everything from last Tuesday"
- "Give me a standup summary"
- "What did I do this morning/afternoon/evening?"
- "Review my work from March 15 to March 20"
- "What's been going on across my projects this week?"
- "Summarize my activity for the past 3 days"

Convert relative time references to ISO 8601 timestamps:

- "today" → `--after <today 00:00 local>` `--before <now>`
- "yesterday" → `--after <yesterday 00:00>` `--before <yesterday 23:59:59>`
- "this morning" → `--after <today 06:00>` `--before <today 12:00>`
- "this week" → `--after <Monday 00:00>` `--before <now>`
- "last Tuesday" → `--after <last Tue 00:00>` `--before <last Tue 23:59:59>`

Timestamps must be ISO 8601 (e.g., `2026-03-25T00:00:00Z`). Date-only formats like `2026-03-25` also work (interpreted as midnight UTC).

### Use the bundled scripts

The `scripts/` directory contains executable wrappers for all API endpoints. **Always use these scripts** instead of raw curl commands — they handle URL construction, JSON formatting, and URL encoding.

Run scripts using their full path relative to this skill's base directory (provided when the skill is loaded). For example: `<skill-base-dir>/scripts/search --query "test"`

All scripts default to `http://localhost:2529`. Override with `CLAUDE_ASSIST_SERVER` env var.

Available scripts: `search`, `transcript`, `details`, `stats`, `activity`, `machines`, `sync`, `outlines`, `outline-progress`

### Filter Out Subagent Sessions

Always include `--min-user-messages 2` by default to hide single-prompt subagent sessions. Only omit this filter if the user specifically asks about subagent or automated sessions.

### Default to Current Project

When searching sessions, **always filter by the current project path** unless:

- The user explicitly asks to search across all projects
- The user asks about work on "another project" or "different repo"
- The context clearly implies cross-project search is needed

The `project=` parameter matches any substring of the project path, so use a **minimally unique string** that appropriately scopes the search. For example:

- For `/Users/chris/repos/claude-assist`, use `project=claude-assist` (not the full path)
- For `/home/dev/projects/api-server`, use `project=api-server`

This keeps queries concise while still filtering effectively.

## Quick Start

Search sessions by topic (scoped to current project):

```bash
scripts/search --query "RTD proposal" --days 14 --project myproject --min-user-messages 2
```

Review what happened during a time period (cross-session):

```bash
scripts/transcript --after 2026-03-28T00:00:00Z --before 2026-03-29T00:00:00Z
scripts/transcript --after 2026-03-24T00:00:00Z --before 2026-03-29T00:00:00Z --project claude-assist
```

## Available Endpoints

### Search Sessions

```bash
scripts/search --query "..." --days N --project PATH --tools Edit,Bash --machine ID
```

Parameters:

- `search` - Full-text search query (weighted: user prompts + outlines > tools/files > project)
- `days` - Limit to sessions within N days (default: 30)
- `since` - Absolute start date (ISO 8601, e.g., `2025-01-01T00:00:00Z`). Overrides `days` when set
- `until` - Absolute end date (ISO 8601). Can combine with `since` or use alone with `days`
- `forever` - Set to `true` to search all sessions with no date limit. Use when the user's query indicates they want an absolute answer regardless of recency (e.g., "have we ever...", "did I ever...")
- `tools` - Filter by tools used (comma-separated, e.g., `Edit,Bash`)
- `machine` - Filter by machine ID (e.g., `localhost`, `laptop`)
- `project` - Filter by project path (partial match)
- `min_user_messages` - Minimum number of user messages (useful for hiding subagent sessions, e.g., `--min-user-messages 2`)
- `limit` - Max results (default: 20, max: 100)
- `offset` - Pagination offset

**Date filtering:** By default, searches are limited to the last 30 days. Use `days` for relative filtering, `since`/`until` for absolute date ranges, or `forever=true` to search all time. When `since` or `until` is provided, they take precedence over `days`. `forever=true` disables all date filtering.

Response schema: see [schemas/search.json](schemas/search.json)

**Note:** The `outline` field contains an AI-generated summary of the session (if available). The `title` field is a short AI-generated title.

### Get Session Transcript (Preferred)

```bash
# Full session transcript
scripts/transcript <session-id>

# Only messages from a specific time window within the session
scripts/transcript <session-id> --after 2026-03-25T00:00:00Z --before 2026-03-26T00:00:00Z

# Just the afternoon portion
scripts/transcript <session-id> --after 2026-03-25T12:00:00Z --before 2026-03-25T18:00:00Z
```

Returns a **compact, token-efficient text format** of the session—the same format used for AI outline generation. This is the **recommended way to read full session content**.

Optional time-range params trim the transcript to only messages within the window. Useful for long-running sessions where you only care about a specific period:

- `--after` - Only include messages after this ISO 8601 timestamp
- `--before` - Only include messages before this ISO 8601 timestamp

Both params are optional and can be used independently (just `--after` to get everything from a point onward, or just `--before` to get everything up to a point).

Format:

- `[U] <text>` - Full user messages
- `[A] <snippet>` - Assistant responses (truncated to ~280 chars)
- `[T] <tool_name> <target>` - Tool calls with file paths, commands, etc.

Example response: see [schemas/transcript.txt](schemas/transcript.txt) (text/plain, not JSON)

**Use this endpoint when:**

- Reading a full session's conversation flow
- Understanding what happened in a session
- Copying session context for continuation
- Trimming a long session to just the relevant time window (e.g., "what did this session do after 3pm?")

**Use `--raw` only when:**

- You need exact tool inputs/outputs
- You need token usage per message
- You need raw content blocks (thinking, tool results)

### Cross-Session Transcript (Time Range)

```bash
# All work across all projects today
scripts/transcript --after 2026-03-29T00:00:00Z --before 2026-03-29T23:59:59Z

# Chronological order instead of grouped by project
scripts/transcript --after 2026-03-29T00:00:00Z --before 2026-03-29T23:59:59Z --group time

# Scoped to a single project
scripts/transcript --after 2026-03-29T00:00:00Z --before 2026-03-29T23:59:59Z --project claude-assist

# Multi-day range
scripts/transcript --after 2026-03-24T00:00:00Z --before 2026-03-29T00:00:00Z

# Include subagent sessions (normally filtered out)
scripts/transcript --after 2026-03-29T00:00:00Z --before 2026-03-29T23:59:59Z --min-user-messages 0
```

When called **without a session ID**, returns an LLM-optimized transcript across all sessions that overlap the given time range. Both `--after` and `--before` are required.

**This is the primary tool for temporal queries** — any time the user asks "what did I work on" during some period, this is the endpoint to use.

Parameters:

- `--after` - Start of time range (ISO 8601, required). Date-only like `2026-03-25` works (midnight UTC)
- `--before` - End of time range (ISO 8601, required). Date-only like `2026-03-26` works (midnight UTC)
- `--group` - Output grouping: `project` (default) or `time`
- `--project` - Filter to sessions matching this project path (partial match)
- `--min-user-messages` - Minimum user messages to include session (default: 2, filters out subagent sessions)

**`--group project`** (default) groups sessions under project path headers — best for standup summaries and "what did I do" questions where the project context matters:

```
=== /Users/chris/repos/my-app ===

--- 2026-03-25T10:00:00Z ---
[U] fix the login bug
[A] I'll look at the auth module...

=== /Users/chris/repos/other ===

--- 2026-03-25T11:00:00Z ---
[U] update README
```

**`--group time`** sequences all sessions chronologically with project in each header — best for understanding the order of work across projects:

```
--- [/Users/chris/repos/my-app] 2026-03-25T10:00:00Z ---
[U] fix the login bug
[A] I'll look at the auth module...

--- [/Users/chris/repos/other] 2026-03-25T11:00:00Z ---
[U] update README
```

**How session overlap works:** Sessions are included if they overlap the time window at all (started before `--before` AND ended after `--after`). But only **messages with timestamps inside the window** are returned. Long-running sessions that span days will only show the relevant portion. Session headers are clamped to the `--after` bound so you won't see misleading dates from before your window.

**When to use this:**

- "What did I work on today?" → all projects, today's window
- "What happened this morning?" → all projects, morning window
- "Give me a standup summary" → all projects, since yesterday
- "What did I do on the claude-assist project this week?" → scoped to project, week window
- "Show me everything from last Tuesday" → all projects, single day
- "Summarize activity across all projects for the past 3 days" → all projects, 3-day window
- "What was the chronological order of my work yesterday?" → `--group time`, yesterday's window

### Get Session Details

```bash
scripts/details <session-id>        # metadata only
scripts/details <session-id> --raw  # include full raw messages
```

Returns session metadata plus optionally the full `raw_messages` array (parsed JSONL messages).

Response schema: see [schemas/details.json](schemas/details.json)

### Session Statistics

```bash
scripts/stats --days 30 --machine laptop
```

Parameters:

- `days` - Period to analyze (default: 30)
- `machine` - Filter by machine ID

Response schema: see [schemas/stats.json](schemas/stats.json)

### Activity Ranges

```bash
scripts/activity --days 7
```

Returns sessions with their computed activity time ranges for the last N days. Activity ranges are contiguous periods of user interaction, segmented by a 30-minute gap threshold. Use this to understand **when** work happened (time blocks), as opposed to **what** happened (use transcript for that).

Parameters:

- `--days` - Number of days to look back (default: 7)

Response schema: see [schemas/activity.json](schemas/activity.json)

**When to use this:**

- "When was I working today?" — understand time blocks, not content
- "How much time did I spend on X this week?" — sum activity range durations per project
- "Was I active last night?" — check for late-night activity ranges

### List Machines

```bash
scripts/machines
```

Returns all registered machines with sync status. Response schema: see [schemas/machines.json](schemas/machines.json)

### Manual Sync (Localhost)

```bash
scripts/sync
```

Triggers an immediate sync of local sessions. Returns sync results:

```json
{
  "sessionsScanned": 10,
  "sessionsIngested": 5,
  "sessionsUpdated": 2,
  "sessionsSkipped": 3,
  "errors": []
}
```

### Generate Outlines

```bash
scripts/outlines                         # all pending
scripts/outlines <session-id> [...]      # specific sessions
```

Manually triggers AI outline generation for sessions without outlines (or with stale outlines). Requires `ANTHROPIC_API_KEY` to be configured.

Returns:

```json
{
  "sessionsProcessed": 50,
  "outlinesGenerated": 45,
  "skipped": 3,
  "errors": ["Failed to generate outline for uuid3: rate limit"]
}
```

### Outline Generation Progress

```bash
scripts/outline-progress
```

Check the progress of background outline generation:

```json
{
  "completed": 25,
  "total": 50,
  "currentSession": "9c8a4c11-c051-4381-90cd-ef3f380a91c8",
  "errors": 2,
  "isRunning": true
}
```

### Push from Satellite (API)

Push is typically done via the CLI (see below), not manually.

## Multi-Machine Support

### Localhost (Automatic)

Sessions are automatically synced every 5 minutes from `~/.claude/` on the server machine. The server's machine is labeled `localhost`.

### Satellite Machines (Manual Push)

From any machine with Bun installed:

```bash
bunx @jarvus/claude-assist-sessions push --machine laptop --server https://my-server.com
```

Options:

- `-m, --machine <id>` - Machine identifier (required, e.g., "laptop", "devbox")
- `-s, --server <url>` - Server URL (default: <http://localhost:2529>)
- `--claude-dir <path>` - Claude directory (default: ~/.claude)
- `--dry-run` - Preview without pushing
- `-v, --verbose` - Detailed output

## Common Workflows

### "What did I work on today?"

Use cross-session transcript with today's date range across all projects:

```bash
scripts/transcript --after 2026-03-29T00:00:00Z --before 2026-03-29T23:59:59Z
```

Then summarize the returned transcript for the user, highlighting key accomplishments per project.

### "Give me a standup summary" / "What did I do yesterday?"

```bash
scripts/transcript --after 2026-03-28T00:00:00Z --before 2026-03-29T00:00:00Z
```

Summarize by project, focusing on what was accomplished and any blockers.

### "What did we discuss about X?"

Use search first to find relevant sessions, then pull transcripts for the top results:

```bash
scripts/search --query "auth refactor" --project myproject --min-user-messages 2
scripts/transcript <session-id-from-results>
```

### "Where did we leave off on this project?"

Search for the most recent sessions in the current project:

```bash
scripts/search --days 7 --project myproject --min-user-messages 2 --limit 5
scripts/transcript <most-recent-session-id>
```

### "What happened on this project this week?"

Use cross-session transcript scoped to the project:

```bash
scripts/transcript --after 2026-03-24T00:00:00Z --before 2026-03-29T23:59:59Z --project claude-assist
```

### "Show me the chronological order of all my work on Monday"

Use `--group time` to interleave sessions across projects:

```bash
scripts/transcript --after 2026-03-24T00:00:00Z --before 2026-03-25T00:00:00Z --group time
```

## Usage Tips

1. **Time-based questions → cross-session transcript.** If the user mentions a time period (today, yesterday, this week, a date), use `scripts/transcript --after ... --before ...` without a session ID
2. **Topic-based questions → search.** If the user mentions a topic, keyword, or feature name, use `scripts/search`
3. Start with a broad search, then narrow by project or machine
4. Use `--days` to focus on recent sessions in search
5. Filter by `--tools` to find sessions with specific activities (e.g., `--tools Edit,Bash`)
6. **Prefer `scripts/transcript`** for reading session content—it's compact and token-efficient
7. Only use `--raw` when you need exact tool inputs/outputs or token usage
8. Use `--machine` filter when looking for work done on a specific device
9. Use `--group time` when chronological ordering across projects matters
10. Use `--project` on cross-session transcripts to reduce noise when the user only cares about one repo

## jq Recipes

Common `jq` patterns for processing endpoint output. All scripts output JSON (except `transcript` which outputs text/plain).

### Search — list session titles with dates

```bash
scripts/search --query "auth" --min-user-messages 2 | jq '.[] | {title, started_at, id}'
```

### Search — sessions that used specific tools

```bash
scripts/search --days 7 --min-user-messages 2 | jq '[.[] | select(.tools_used | index("Bash"))] | length'
```

### Activity — total active minutes per project this week

```bash
scripts/activity --days 7 | jq '[group_by(.project_name)[] | {project: .[0].project_name, sessions: length, minutes: (map(.total_active_minutes) | add)}] | sort_by(-.minutes)'
```

### Activity — list today's activity ranges with times

```bash
scripts/activity --days 1 | jq '.[] | {title, project_name, ranges: [.activity_ranges[] | "\(.start[11:16])-\(.end[11:16]) (\(.duration_minutes)m)"]}'
```

### Activity — total hours across all projects

```bash
scripts/activity --days 7 | jq '[.[].total_active_minutes] | add / 60 | round'
```

### Stats — top 5 tools

```bash
scripts/stats --days 7 | jq '.top_tools[:5] | .[] | "\(.tool): \(.count)"'
```

### Stats — token cost breakdown by model

```bash
scripts/stats --days 30 | jq '.top_models[] | {model, sessions: .session_count, input_mtok: (.input_tokens / 1000000 | round), output_mtok: (.output_tokens / 1000000 | round)}'
```

### Details — list all files written in a session

```bash
scripts/details <session-id> | jq '.files_touched.writes[]'
```

### Machines — find last sync time

```bash
scripts/machines | jq '.[] | {machine_id, last_sync_at}'
```

## Architecture

- Sessions stored in PostgreSQL with full-text search (weighted tsvector)
- Host machine syncs automatically every 5 minutes
- Satellite machines push manually via CLI
- MD5 content hashing prevents duplicate ingestion
- Raw transcripts are stored for complete archive (Claude prunes after ~1 month)
- AI-generated outlines created asynchronously using Claude Haiku (if `ANTHROPIC_API_KEY` configured)
- Outlines are regenerated automatically when session transcripts change
