---
name: assist-sessions
description: >-
  Search past Claude sessions for context. Use when asked "where did we leave off?",
  "what did we discuss about X?", "find a previous conversation", or when needing context
  from earlier work across machines. Also use for time-based queries like "what did I work
  on today/yesterday/this week/this morning?", "what happened on Monday?", "show me
  everything from last Tuesday", "give me a standup summary", or any request to review
  work across a time period or across projects.
---

# assist-sessions

Search and recall context from past Claude Code sessions across machines, via the
bundled **`sessions-axi`** CLI — a script in this skill's `scripts/` directory (not
on `PATH`). Invoke it by its path relative to this skill's base directory:

```bash
scripts/sessions-axi                     # home: recent activity + next steps
scripts/sessions-axi --help              # full command list
scripts/sessions-axi <command> --help    # usage for any command
```

Output is [TOON](https://toonformat.dev) (compact tables); pass `--json` for raw API
JSON. The server defaults to `http://localhost:2529`; override with the
`CLAUDE_ASSIST_SERVER` environment variable.

## Choosing the right command: search vs transcript

**This is the most important decision.**

| User intent | Command |
|---|---|
| Find sessions **about a topic** ("what did we discuss about auth?") | `search --query ...` |
| Review **what happened in a time period** ("what did I do today?") | `transcript --after ... --before ...` (no id) |
| Check **when** work happened ("how much time on X?") | `activity --days N` |
| Read a **specific session** | `transcript <session-id>` |

**Key rule:** if the question names a time period (today, yesterday, this morning, last
week, Monday, a date range), use the **cross-session transcript** (`transcript --after
--before` with no id) — not search. Search finds sessions by topic; the transcript
endpoint reconstructs what actually happened in a window.

## Recognizing temporal queries

Use cross-session `transcript --after --before` for: "what did I work on
today/yesterday/this week?", "what happened on Monday?", "give me a standup summary",
"review my work from March 15–20", "what's been going on across my projects?".

Convert relative time to ISO 8601 (e.g. `2026-06-23T00:00:00Z`); date-only
`2026-06-23` also works (midnight UTC):

- "today" → `--after <today 00:00>` `--before <now>`
- "yesterday" → `--after <yesterday 00:00>` `--before <yesterday 23:59:59>`
- "this week" → `--after <Monday 00:00>` `--before <now>`

## Defaults that matter

- **Hide subagent sessions:** pass `--min-user-messages 2` on `search` and rely on the
  transcript default (also 2). Only omit when the user asks about subagent/automated runs.
- **Scope to the current project:** unless the user asks across all projects, pass
  `--project <repo>` using a minimally-unique substring (e.g. `--project claude-assist`,
  not the full path). `--project` matches any substring of the project path.
- **Substring filters:** `--tools`, `--files-read`, and `--files-written` all match
  substrings (e.g. `--tools mcp__plugin_slack` matches every Slack MCP tool).

## Commands

<!-- BEGIN GENERATED: command-reference -->

### Recall

- `scripts/sessions-axi search [--query TEXT] [--project PATH] [--days N | --since DATE --until DATE | --forever] [--tools a,b] [--files-read frag] [--files-written frag] [--machine ID] [--min-user-messages N] [--include-empty] [--limit N] [--offset N]` — find sessions by topic/tool/file (tools & files are substring matches); defaults to last 30 days, hides subagent sessions at --min-user-messages 2
- `scripts/sessions-axi transcript <session-id> [--after DATE] [--before DATE] [--include-tools]` — compact, token-efficient transcript of one session (optionally trimmed to a time window)
- `scripts/sessions-axi transcript --after DATE --before DATE [--group project|time] [--project PATH] [--min-user-messages N] [--include-tools]` — cross-session transcript for a time range — the primary tool for "what did I work on <when>?"
- `scripts/sessions-axi details <session-id> [--raw]` — session metadata; --raw adds the parsed raw messages
- `scripts/sessions-axi activity [--days N]` — when work happened — active time blocks per session (default 7 days)

### Overview

- `scripts/sessions-axi stats [--days N] [--machine ID]` — usage statistics: top tools, models, tokens, per-machine counts
- `scripts/sessions-axi machines` — list registered machines with sync status

### Manage

- `scripts/sessions-axi outlines [<session-id>...]` — generate AI outlines for sessions missing/stale ones (needs ANTHROPIC_API_KEY)
- `scripts/sessions-axi outlines progress` — check background outline-generation progress
- `scripts/sessions-axi sync [--force]` — trigger an immediate local session sync (--force re-parses all)
- `scripts/sessions-axi share <session-id>` — mint a shareable auth code for a session transcript

<!-- END GENERATED: command-reference -->

## Common workflows

- **"What did I work on today?"** →
  `scripts/sessions-axi transcript --after <today 00:00> --before <now>` then summarize per project.
- **"Standup / what did I do yesterday?"** →
  `scripts/sessions-axi transcript --after <yesterday 00:00> --before <today 00:00>`.
- **"What did we discuss about X?"** → `scripts/sessions-axi search --query "X" --project <repo>
  --min-user-messages 2`, then `scripts/sessions-axi transcript <top-result-id>`.
- **"Where did we leave off?"** → `scripts/sessions-axi search --days 7 --project <repo>
  --min-user-messages 2 --limit 5`, then read the most recent transcript.

## Notes

- Sessions are stored in PostgreSQL with weighted full-text search; the host syncs
  `~/.claude/` automatically, satellite machines push via the package CLI.
- AI outlines/titles are generated asynchronously when `ANTHROPIC_API_KEY` is set; trigger
  manually with `scripts/sessions-axi outlines`.
- Transcript output is text (`[U]` user, `[A]` assistant, `[T]` tool); everything else is
  TOON, with `--json` for raw JSON and `details <id> --raw` for full raw messages.
