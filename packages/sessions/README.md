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
| ---------- | ------------- |
| `GET /sessions` | Search with FTS and filters |
| `GET /sessions/:id` | Session details (`?with_raw_messages=true`) |
| `GET /sessions/:id/transcript` | Compact transcript (text/plain) |
| `GET /sessions/stats` | Usage statistics |
| `GET /machines` | List registered machines |
| `POST /sessions/sync` | Trigger manual localhost sync |
| `POST /sessions/push` | Receive sessions from satellites |

## Query Parameters

| Param | Default | Description |
| ------- | --------- | ------------- |
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

Some local tools spawn large volumes of tiny, automated Claude sessions — a review-item
triage runner, a batch linter, a cron that asks one question — and they flood the archive.
They pass the subagent/min-size filters because they're real UUID-named transcripts above
the size threshold.

Ingest suppresses any session whose **parsed user messages** contain a configured marker
substring. Matching parsed user messages — not raw transcript text — is deliberate: a
legitimate session that merely quotes a marker in tool output or assistant prose is *not*
dropped, only sessions whose initiating prompt is the automation's marker.

There are no built-in markers — which automation counts as noise is a property of your
deployment, not of the toolkit. Declare yours in the `SESSIONS_IGNORE_MARKERS` env var
(newline-separated), using the stable opening line of the automation's prompt:

```bash
SESSIONS_IGNORE_MARKERS="You are triaging a review item.
Another automation prompt prefix"
```

Suppression applies on the host scan, the satellite push CLI's inventory, and as a
server-side net in the push endpoint (so satellites on an older CLI are still filtered).
It only blocks *future* ingest — existing rows must be deleted separately.

## Classification pipeline (self-improvement loop)

On top of ingestion + outlines, the module runs a per-session **classification**
pipeline that feeds a weekly self-improvement review. It has three moving parts,
all in `src/classification/`:

1. **Per-session incremental cursors** (`classification_cursors`). A long-running
   session re-ingests repeatedly as it evolves; the cursor tracks the last
   classified message seq (aligned with `tool_calls.msg_index`), so each cycle
   classifies only the **delta**. Re-serializing from the advanced cursor yields
   an empty window — classification is delta-only and idempotent. A session quiet
   for >48h gets a terminal (final) pass and is then flagged done.

2. **Classification events** (`classification_events`, APPEND-ONLY). A cheap
   classify-tier pass over each new-message window records typed signals —
   `correction` (highest value), `friction`, `rule-candidate`,
   `notable-decision` — each with a seq range, one-line summary, confidence, and
   a verbatim quote. Windows usually yield nothing; the prompt is tuned for
   signal density. No window ever rewrites a prior window's events.

3. **Weekly synthesis + narrative** (`synthesis_reports`). Once a week the strong
   synthesize tier digests the events into a structured report — proposed
   memory/rule/hook/skill/spec changes and ranked friction hotspots — plus an
   dev-diary-style narrative of how the system evolved. Both are persisted
   **and** delivered via the notify digest.

The scheduled sweep beats a `session-classification` heartbeat; the weekly job
beats `session-synthesis`. Both are coverage ledgers that page on absence.

### Cost posture — no auto-backfill

The scheduled sweep only looks back `SESSIONS_CLASSIFICATION_LOOKBACK` (default
`3 days`) of transcript **activity** (`synced_at`, which ingestion bumps only
when content changes) — so a months-old session resumed today is swept, while
deploying this does **not** classify the ~2,400-session untouched backlog. A
resumed session whose earlier final pass is now behind new messages has its
`final_pass_done` flag reset, so the resumed segment gets its own quiet-time
final pass. Keep the lookback comfortably above the 48h quiet threshold — the
quiet flush for a small held tail must fire while the session is still inside
the window.
Historical coverage is an explicit, bounded backfill:

```bash
# Recommended initial window: 30 days.
curl -XPOST "$BASE/api/sessions/classify/backfill?since=$(date -u -d '30 days ago' +%FT%TZ)"
```

`since` is required — a backfill can never be unbounded. Other endpoints:
`POST /sessions/classify` (trigger a sweep), `POST /sessions/synthesis`
(run the week's synthesis + narrative, persist only),
`GET /sessions/classification/events`, `GET /sessions/classification/reports`.

## Acknowledgments

This module was heavily inspired by [kuato](https://github.com/alexknowshtml/kuato), a session recall tool that addresses Claude Code's "agent amnesia" between conversations. The core design patterns—extracting user messages, tools used, and files touched as the primary search signals, with weighted full-text search prioritizing user prompts—originated from kuato's approach to session archaeology.
