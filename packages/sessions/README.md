# @jarvus/claude-assist-sessions

Archives Claude Code transcripts from `~/.claude/` into PostgreSQL with full-text search and multi-machine support.

## Features

- Automatic sync every 5 minutes on host machine
- Push CLI for satellite machines
- Weighted full-text search (user prompts > tools/files > project)
- MD5 hash-based deduplication
- Complete transcript archive (Claude prunes after ~1 month)

## Quickstart

```bash
# Start database
cd apps/server && docker-compose up postgres -d

# Start server (syncs local sessions automatically)
bun run dev

# Trigger manual sync
curl -X POST http://localhost:2529/sessions/sync

# Search sessions
curl "http://localhost:2529/sessions?search=refactor&days=7"
```

## Full Lifecycle

### 1. Setup

```bash
bun install
bun run build
cd apps/server && docker-compose up postgres -d
bun run dev
```

### 2. Search Sessions

```bash
# Full-text search
curl "http://localhost:2529/sessions?search=authentication"

# Filter by tools used
curl "http://localhost:2529/sessions?tools=Edit,Bash"

# Filter by project path
curl "http://localhost:2529/sessions?project=claude-assist"

# Filter by machine
curl "http://localhost:2529/sessions?machine=laptop"

# Combine filters
curl "http://localhost:2529/sessions?search=bug&days=14&tools=Edit"
```

### 3. Get Session Details

```bash
# Metadata only
curl "http://localhost:2529/sessions/<uuid>"

# Get compact transcript (token-efficient format)
curl "http://localhost:2529/sessions/<uuid>/transcript"

# Include full raw messages (large, use sparingly)
curl "http://localhost:2529/sessions/<uuid>?with_raw_messages=true"
```

### 4. View Statistics

```bash
curl "http://localhost:2529/sessions/stats?days=30"
```

### 5. Push from Satellite Machines

```bash
# Preview what would be pushed
bunx @jarvus/claude-assist-sessions push -m laptop --dry-run -v

# Push to server
bunx @jarvus/claude-assist-sessions push -m laptop -s https://my-server.com
```

### 6. List Machines

```bash
curl http://localhost:2529/machines
```

## API Reference

| Endpoint | Description |
|----------|-------------|
| `GET /sessions` | Search with FTS and filters |
| `GET /sessions/:id` | Session details (`?with_raw_messages=true`) |
| `GET /sessions/:id/transcript` | Compact transcript (text/plain) |
| `GET /sessions/stats` | Usage statistics |
| `GET /machines` | List registered machines |
| `POST /sessions/sync` | Trigger manual localhost sync |
| `POST /sessions/push` | Receive sessions from satellites |

## Query Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `search` | - | Full-text search query |
| `days` | 30 | Limit to N days ago |
| `tools` | - | Filter by tools (comma-separated) |
| `machine` | - | Filter by machine ID |
| `project` | - | Filter by project path (partial match) |
| `limit` | 20 | Max results (max 100) |
| `offset` | 0 | Pagination offset |

## CLI Options

```
bunx @jarvus/claude-assist-sessions push [options]

  -m, --machine <id>     Machine identifier (required)
  -s, --server <url>     Server URL (default: http://localhost:2529)
  --claude-dir <path>    Claude directory (default: ~/.claude)
  --dry-run              Scan without pushing
  -v, --verbose          Detailed output
```

## Acknowledgments

This module was heavily inspired by [kuato](https://github.com/alexknowshtml/kuato), a session recall tool that addresses Claude Code's "agent amnesia" between conversations. The core design patterns—extracting user messages, tools used, and files touched as the primary search signals, with weighted full-text search prioritizing user prompts—originated from kuato's approach to session archaeology.
