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

Sessions on the machine running the server are synced automatically every 5 minutes. For other machines ("satellites"), use the push CLI to send sessions to the server:

```bash
# Preview what would be pushed
bunx @jarvus/claude-assist-sessions push -m laptop --dry-run -v

# Push to server
bunx @jarvus/claude-assist-sessions push -m laptop -s https://my-server.com
```

#### Schedule Automatic Push (macOS)

On satellite machines, create a launchd plist to push sessions every 5 minutes:

```bash
cat > ~/Library/LaunchAgents/com.jarvus.claude-assist-push.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jarvus.claude-assist-push</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/bun</string>
        <string>run</string>
        <string>packages/sessions/bin/push.ts</string>
        <string>--machine</string>
        <string>my-mac</string>
        <string>--server</string>
        <string>http://my-server:2529</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/claude-assist</string>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/me/Library/Logs/claude-assist-push.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/me/Library/Logs/claude-assist-push.error.log</string>
</dict>
</plist>
EOF
```

Update the paths and machine name, then load the job:

```bash
# Find your bun path (use direct path, not shims)
asdf where bun  # e.g., ~/.asdf/installs/bun/1.3.6/bin/bun

# Load the scheduled job
launchctl load ~/Library/LaunchAgents/com.jarvus.claude-assist-push.plist

# Check status (exit code 0 = success)
launchctl list | grep claude-assist

# View logs
tail -f ~/Library/Logs/claude-assist-push.log

# Unload to stop
launchctl unload ~/Library/LaunchAgents/com.jarvus.claude-assist-push.plist
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

## Suppressing automated sessions

Some local tools spawn large volumes of tiny, automated Claude sessions (e.g. the M87
review-item triage runner) that flood the archive. These pass the subagent/min-size
filters because they're real UUID-named transcripts above the size threshold.

Ingest suppresses any session whose **parsed user messages** contain a configured marker
substring. Matching parsed user messages — not raw transcript text — is deliberate: a
legitimate session that merely quotes a marker in tool output or assistant prose is *not*
dropped, only sessions whose initiating prompt is the automation's marker.

A built-in default suppresses the M87 triage runner. Add your own via the
`SESSIONS_IGNORE_MARKERS` env var (newline-separated; appended to the defaults):

```bash
SESSIONS_IGNORE_MARKERS="You are triaging a local-first M87 review item.
Another automation prompt prefix"
```

Suppression applies on the host scan, the satellite push CLI's inventory, and as a
server-side net in the push endpoint (so satellites on an older CLI are still filtered).
It only blocks *future* ingest — existing rows must be deleted separately.

## Acknowledgments

This module was heavily inspired by [kuato](https://github.com/alexknowshtml/kuato), a session recall tool that addresses Claude Code's "agent amnesia" between conversations. The core design patterns—extracting user messages, tools used, and files touched as the primary search signals, with weighted full-text search prioritizing user prompts—originated from kuato's approach to session archaeology.
