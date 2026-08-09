# claude-assist

A toolkit for building your own Claude-based personal assistant: a Fastify-on-Bun
server, a Postgres schema, and a set of composable modules for the parts every
such assistant needs — recalling past sessions, triaging email, watching a
calendar, capturing stray thoughts, notifying a phone, and metering what the
models cost.

## The toolkit and your instance

**This repository is the toolkit. It is not anyone's assistant.**

Everything here is generic: mechanisms, schemas, and pluggable seams. The things
that make an assistant *yours* — who the owner is, which CLIs they run, what
their triage rules say, which timezone their day starts in, which automation
floods their session archive — are **instance data**, and they live in your
deployment's environment and database, never in this repo.

The line shows up everywhere in the design, and it is worth knowing before you
read the code:

| The toolkit ships | Your instance supplies |
| --- | --- |
| The extraction-rule *mechanism* for the audit ledger | `LEDGER_EXTRA_RULES` naming your own CLIs |
| A commitments source that shells out to any CLI | `BRIEFING_COMMITMENTS_BIN` pointing at yours |
| Email triage rules as a seeded, editable table | `GOOGLE_TRIAGE_SEED_FILE` with your first rules |
| Ingest suppression by prompt marker | `SESSIONS_IGNORE_MARKERS` for your noisy automation |
| Tier → model mapping and spend accounting | `ANTHROPIC_API_KEY` and your budget ceilings |
| Every date computation, zone-aware | `BRIEFING_TIMEZONE` etc. — no zone is a default |

Where a value is instance data, the toolkit ships **no default** rather than a
plausible-looking one: an unset timezone falls back to UTC and says so, an unset
rule list is empty. A wrong-but-reasonable default is worse than an absent one,
because it works quietly until the day it doesn't.

`specs/` states what should be true of the system; `docs/` holds design records.
Start with [`specs/architecture.md`](specs/architecture.md) and
[`specs/principles.md`](specs/principles.md).

## Installation

Install the skills globally with [`skills`](https://github.com/obra/skills):

```
npx skills add -g JarvusInnovations/claude-assist
```

This installs the skills listed under [Skills](#skills) below. Each ships a
self-contained `*-axi` AXI CLI under its `scripts/` directory; use them to search
past sessions, manage Gmail, and drive the kitchen journal.

**Note:** The skills require a running backend server with PostgreSQL. See [Quick Start](#quick-start) below.

## Prerequisites

- Docker with Compose plugin

## Quick Start

```bash
cd apps/server
docker compose up --build -d
```

The API will be available at <http://localhost:2529>

Sessions from `~/.claude/` on the host machine sync automatically. To sync from other machines:

```bash
bunx @jarvus/claude-assist-sessions push -m laptop -s https://your-server:2529
```

## Environment Setup

Copy the example environment file and configure:

```bash
cp apps/server/.env.example apps/server/.env
```

`.env.example` is the annotated reference for every setting — read it top to
bottom the first time. The two that matter immediately:

- `ANTHROPIC_API_KEY` — the one metered credential. Every module that needs a
  model reaches it through the invoker, so this key is read in exactly one
  place and every call it pays for lands on a spend ledger. Get one at
  <https://console.anthropic.com/>. Without it, model-backed features degrade
  to their deterministic paths instead of failing.
- The owner-locale timezones (`BRIEFING_TIMEZONE`, `KITCHEN_OWNER_TZ`,
  `GOOGLE_URGENCY_TZ`, `SLACK_URGENCY_TZ`) — unset means UTC, which is rarely
  what you want for "today" or for quiet hours.

## Local Development

For contributors who want to develop locally with hot reload:

```bash
# Install bun via asdf (uses .tool-versions) or directly from bun.sh
asdf install  # or: curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Start PostgreSQL only
cd apps/server
docker compose up postgres -d

# Start development server with watch mode
bun run dev
```

**VS Code debugging:** Use the provided launch configurations in `.vscode/launch.json`:

- "Debug Server" - runs with watch mode and debugger attached
- "Debug Server (no watch)" - single run with debugger
- "Attach to Bun" - attach to running bun process

## Project Structure

Each module is a Fastify plugin owning its own migrations, routes, and schema;
the host registers them in a load-bearing order and they talk to each other only
through decorators, never by importing one another.

```
packages/
  core/           # Contracts, scheduler, advisory locks, lease queue
  invoker/        # The single choke point for metered model calls
  approvals/      # Generic human-approval gate (nothing ever blocks on a human)
  sessions/       # Session ingest, recall, outlines, classification, synthesis
  google/         # Gmail sync, triage, urgency, calendar OAuth
  briefing/       # Daily briefing + meeting alerts + per-meeting preps
  capture/        # Fast idempotent capture, then classify-and-route
  kitchen/        # Consumption journal, inventory, receipts, recipes
  training/       # Weekly adaptive training plans, gated on async approval
  finance/        # Personal ledger mirror + monthly review batch (opt-in)
  notify/         # Notification dispatcher + heartbeat/coverage registry
  ledger/         # Derived audit ledger over ingested tool calls
  pages/          # Publish interactive HTML, collect structured responses
  chat/           # Slack-fronted agent
  slack-urgency/  # Read-only Slack listener; interrupts only when earned
  session-spawn/  # Warm an interactive session, ping a phone with the link
apps/
  server/         # Fastify host: env schema, plugin registration order
  admin/          # Admin UI
skills/
  assist-sessions/      # Session recall (sessions-axi CLI)
  assist-gmail/         # Gmail sync/triage (gmail-axi CLI)
  assist-google-setup/  # Google account + OAuth setup (google-axi CLI)
  assist-kitchen/       # Consumption journal + inventory (kitchen-axi CLI)
specs/            # What should be true of the system
plans/            # Work in flight, and the record of what shipped
docs/             # Design records (e.g. the runtime divergence inventory)
```

## Development

```bash
# Build all packages
bun run build

# Run tests
bun test

# Type check
cd packages/core && bun run build
cd apps/server && bun run build
```

## API Endpoints

All routes are served under an `/api` prefix.

```
GET  /api/health                    # Liveness
GET  /api/scheduler/tasks           # List registered scheduled tasks
POST /api/scheduler/tasks/:name     # Trigger one manually (advisory-locked,
                                    # so it can't race its own scheduled run)
GET  /api/invoker/spend             # Rolling spend, budgets, kill-switch state
GET  /api/approvals                 # Pending human-approval requests
POST /api/approvals/:id/resolve     # Approve / deny / answer one
```

Each module registers its own surface beneath `/api` as well — `/api/sessions`,
`/api/emails`, `/api/capture`, `/api/kitchen`, `/api/training`, `/api/ledger`,
`/api/pages`, `/api/finance`. See
the module's `src/routes.ts` for its endpoints.

## Docker

```bash
cd apps/server

# Start full stack
docker compose up --build -d

# Start PostgreSQL only (for local development)
docker compose up postgres -d

# View logs
docker compose logs -f
```

### Local Port Overrides

By default, services bind to localhost only on ports 2528 (PostgreSQL) and 2529 (API).
To expose on additional interfaces (e.g., Tailscale), create `docker-compose.override.yml` (gitignored):

```yaml
services:
  postgres:
    ports:
      - "127.0.0.1:2528:5432"
      - "<your-ip>:2528:5432"
  api:
    ports:
      - "127.0.0.1:2529:2529"
      - "<your-ip>:2529:2529"
```

Run `docker compose config` to verify the merged configuration.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 2529 | Server port |
| HOST | 0.0.0.0 | Server host |
| DATABASE_URL | postgres://claude:dev@localhost:2528/claude_assist | PostgreSQL connection |
| LOG_LEVEL | info | Log level (debug, info, warn, error) |
| NODE_ENV | development | Environment (development, production) |
| ANTHROPIC_API_KEY | (none) | The one metered credential; read only by the invoker |
| OUTLINE_CONCURRENCY | 5 | Parallel outline generation workers |
| MODEL_TIER_* | (built-in map) | Which model serves each tier of work |
| MODEL_DAILY_BUDGET_USD | (none) | Rolling spend ceiling; breach raises an approval |
| MODEL_KILL_SWITCH | false | Stop all metered calls, host stays healthy |
| BRIEFING_TIMEZONE | (none → UTC) | Owner's zone for "today" and the morning cron |

`apps/server/.env.example` documents every variable, module by module — this
table is only the shortest possible start.

## Skills

Skills are loaded on-demand by Claude. Each bundles a self-contained `*-axi` AXI CLI
(TOON output, content-first home view, generated SKILL.md). Available skills:

- **assist-sessions** (`sessions-axi`) - Search past Claude sessions across machines
- **assist-gmail** (`gmail-axi`) - Gmail sync, triage, and analysis
- **assist-google-setup** (`google-axi`) - Google account + OAuth setup and name aliases
- **assist-kitchen** (`kitchen-axi`) - Consumption journal, inventory, receipts

See `skills/*/SKILL.md` for usage documentation.

### Rebuilding the skill CLIs

The CLI source lives in each module's `src/axi/` directory;
esbuild bundles each to its skill's `scripts/<name>-axi.mjs` and the command reference is
spliced into each SKILL.md. After editing CLI source, run:

```bash
bun run build:skills   # rebuild bundles + splice SKILL.md
bun run check:skills   # CI drift guard — fails if a committed artifact is stale
```

## License

MIT
