---
name: session-recall
description: Search past Claude sessions for context. Use when asked "where did we leave off?" or "what did we discuss about X?"
---

# Session Recall

Search and retrieve context from past Claude Code sessions.

## When to Use

- User asks "where did we leave off on X?"
- User asks "what did we discuss about Y?"
- User wants to find a previous conversation
- You need context from earlier work

## Quick Start

Search sessions by topic:

```bash
curl "http://localhost:3000/sessions?search=RTD&days=14"
```

## Available Endpoints

### Search Sessions

```bash
GET /sessions?search=...&days=...&tools=...
```

Parameters:

- `search` - Full-text search query
- `days` - Limit to sessions within N days (default: 30)
- `tools` - Filter by tools used (comma-separated)

Example response:

```json
[
  {
    "id": "abc-123",
    "started_at": "2025-01-20T10:00:00Z",
    "user_messages": ["Help me with RTD proposal", "Add timeline section"],
    "tools_used": ["Edit", "Read"],
    "files_touched": ["/proposals/rtd.md"]
  }
]
```

### Get Session Details

```bash
GET /sessions/:id?with_transcript=true
```

Parameters:

- `with_transcript` - Include full conversation transcript (default: false)

### Session Statistics

```bash
GET /sessions/stats?days=30
```

Returns summary of session activity over the specified period.

## Usage Tips

1. Start with a broad search, then narrow down
2. Use `days` parameter to focus on recent sessions
3. Filter by `tools` to find sessions with specific activities
4. Request transcript only when you need full context (it's large)

## Note

Session data is synced from `~/.claude/projects/` on the server.
Sync runs automatically every 15 minutes.
