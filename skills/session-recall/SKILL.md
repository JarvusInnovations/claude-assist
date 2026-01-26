---
name: session-recall
description: Search past Claude sessions for context. Use when asked "where did we leave off?", "what did we discuss about X?", "find a previous conversation", or when needing context from earlier work across machines.
---

# Session Recall

Search and retrieve context from past Claude Code sessions across multiple machines.

## Important Behavior

### Default to Current Project

When searching sessions, **always filter by the current project path** unless:

- The user explicitly asks to search across all projects
- The user asks about work on "another project" or "different repo"
- The context clearly implies cross-project search is needed

The `project=` parameter matches any substring of the project path, so use a **minimally unique string** that appropriately scopes the search. For example:

- For `/Users/chris/repos/claude-assist`, use `project=claude-assist` (not the full path)
- For `/home/dev/projects/api-server`, use `project=api-server`

This keeps queries concise while still filtering effectively.

### Server Endpoint

The session recall server may not be running on `localhost:2529`. If your first API request fails (connection refused, timeout, or 404):

1. **Ask the user**: "The session recall server doesn't seem to be running at localhost:2529. Is it running on a different endpoint?"
2. Use whatever endpoint the user provides for subsequent requests
3. Common alternatives: different ports, remote servers, or Docker container URLs

## Quick Start

Search sessions by topic (scoped to current project):

```bash
curl "http://localhost:2529/sessions?search=RTD+proposal&days=14&project=myproject"
```

## Available Endpoints

### Search Sessions

```bash
GET /sessions?search=...&days=...&tools=...&machine=...&project=...
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
- `limit` - Max results (default: 20, max: 100)
- `offset` - Pagination offset

**Date filtering:** By default, searches are limited to the last 30 days. Use `days` for relative filtering, `since`/`until` for absolute date ranges, or `forever=true` to search all time. When `since` or `until` is provided, they take precedence over `days`. `forever=true` disables all date filtering.

Example response:

```json
[
  {
    "id": "9c8a4c11-c051-4381-90cd-ef3f380a91c8",
    "started_at": "2025-01-20T10:00:00Z",
    "ended_at": "2025-01-20T11:30:00Z",
    "project_path": "/Users/chris/repos/myproject",
    "git_branch": "feature/new-api",
    "outline": "Drafted and refined the RTD proposal document, focusing on technical requirements and timeline.\n\n- RTD proposal structure and formatting\n- Technical requirements documentation\n- Timeline and milestone planning",
    "first_user_prompt": "Help me with RTD proposal",
    "message_count": 45,
    "tools_used": ["Edit", "Read", "Bash"],
    "files_touched": ["/proposals/rtd.md"],
    "input_tokens": 150000,
    "output_tokens": 25000,
    "machine": "localhost"
  }
]
```

**Note:** The `outline` field contains an AI-generated summary of the session (if available). Falls back to `first_user_prompt` if outline hasn't been generated yet.

### Get Session Details

```bash
GET /sessions/:id?with_transcript=true
```

Parameters:

- `with_transcript` - Include full conversation transcript (default: false)

Returns session metadata plus optionally the full transcript as parsed JSONL messages.

Response includes:

- Basic metadata: `id`, `machine`, `project_path`, `git_branch`, `started_at`, `ended_at`
- Activity: `user_messages`, `tools_used`, `files_touched`, `message_count`
- Token usage: `input_tokens`, `output_tokens`, `cache_read_tokens`
- Model tracking: `models_used` (array of model IDs), `model_tokens` (per-model breakdown)
- Content: `outline`, `outline_hash`, `claude_version`

Example `model_tokens` structure:

```json
{
  "claude-sonnet-4-20250514": { "input": 150000, "output": 25000 }
}
```

### Session Statistics

```bash
GET /sessions/stats?days=30&machine=laptop
```

Parameters:

- `days` - Period to analyze (default: 30)
- `machine` - Filter by machine ID

Returns:

```json
{
  "period_days": 30,
  "total_sessions": 150,
  "active_days": 25,
  "avg_messages": 42,
  "total_messages": 6300,
  "total_input_tokens": 45000000,
  "total_output_tokens": 7500000,
  "unique_projects": 12,
  "top_tools": [
    { "tool": "Edit", "count": 450 },
    { "tool": "Read", "count": 380 }
  ],
  "top_models": [
    { "model": "claude-sonnet-4-20250514", "session_count": 120, "input_tokens": 30000000, "output_tokens": 5000000 }
  ],
  "sessions_per_machine": [
    { "machine_id": "localhost", "session_count": 120 },
    { "machine_id": "laptop", "session_count": 30 }
  ]
}
```

### List Machines

```bash
GET /machines
```

Returns all registered machines with sync status:

```json
[
  {
    "machine_id": "localhost",
    "hostname": "devbox",
    "is_localhost": true,
    "first_seen_at": "2025-01-15T10:00:00Z",
    "last_sync_at": "2025-01-24T19:30:00Z",
    "session_count": 150
  }
]
```

### Manual Sync (Localhost)

```bash
POST /sessions/sync
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
POST /sessions/outlines
```

Manually triggers AI outline generation for sessions without outlines (or with stale outlines). Requires `ANTHROPIC_API_KEY` to be configured.

Optional body:

```json
{
  "sessionIds": ["uuid1", "uuid2"]
}
```

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
GET /sessions/outlines/progress
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

```bash
POST /sessions/push
Content-Type: application/json

{
  "machineId": "laptop",
  "hostname": "chris-macbook",
  "sessions": [
    {
      "signal": { "session_id": "...", "transcript_path": "...", "cwd": "...", "ended_at": "..." },
      "transcript": "... raw JSONL content ..."
    }
  ]
}
```

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

## Usage Tips

1. Start with a broad search, then narrow by project or machine
2. Use `days` parameter to focus on recent sessions
3. Filter by `tools` to find sessions with specific activities (e.g., `tools=Edit,Bash`)
4. Request transcript only when you need full context (it's large)
5. Use machine filter when looking for work done on a specific device

## Architecture

- Sessions stored in PostgreSQL with full-text search (weighted tsvector)
- Host machine syncs automatically every 5 minutes
- Satellite machines push manually via CLI
- MD5 content hashing prevents duplicate ingestion
- Raw transcripts are stored for complete archive (Claude prunes after ~1 month)
- AI-generated outlines created asynchronously using Claude Haiku (if `ANTHROPIC_API_KEY` configured)
- Outlines are regenerated automatically when session transcripts change
