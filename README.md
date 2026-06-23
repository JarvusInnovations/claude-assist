# claude-assist

Backend services for a Claude-based personal executive assistant. Provides postgres-backed APIs for session recall, email triage, and calendar queries.

## Installation

Install the skills globally with [`skills`](https://github.com/obra/skills):

```
npx skills add -g JarvusInnovations/claude-assist
```

This installs the `assist-sessions`, `assist-gmail`, and `assist-google-setup`
skills. Each ships a self-contained `*-axi` AXI CLI under its `scripts/` directory;
use them to search past sessions and manage Gmail.

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

Edit `.env` to set your `ANTHROPIC_API_KEY` if you want AI-generated session outlines. Get your key at <https://console.anthropic.com/>

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

```
packages/
  core/         # Shared utilities (scheduler, migrations, search)
apps/
  server/       # Fastify host application
skills/
  assist-sessions/      # Session recall (sessions-axi CLI)
  assist-gmail/         # Gmail sync/triage (gmail-axi CLI)
  assist-google-setup/  # Google account + OAuth setup (google-axi CLI)
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

### Health Check

```
GET /health
```

### Scheduler

```
GET  /scheduler/tasks          # List registered tasks
POST /scheduler/tasks/:name    # Trigger task manually
```

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
| ANTHROPIC_API_KEY | (none) | Enables AI-generated session outlines |
| OUTLINE_CONCURRENCY | 5 | Parallel outline generation workers |

## Skills

Skills are loaded on-demand by Claude. Each bundles a self-contained `*-axi` AXI CLI
(TOON output, content-first home view, generated SKILL.md). Available skills:

- **assist-sessions** (`sessions-axi`) - Search past Claude sessions across machines
- **assist-gmail** (`gmail-axi`) - Gmail sync, triage, and analysis
- **assist-google-setup** (`google-axi`) - Google account + OAuth setup and name aliases

See `skills/*/SKILL.md` for usage documentation.

### Rebuilding the skill CLIs

The CLI source lives in `packages/sessions/src/axi/` and `packages/google/src/axi/`;
esbuild bundles each to its skill's `scripts/<name>-axi.mjs` and the command reference is
spliced into each SKILL.md. After editing CLI source, run:

```bash
bun run build:skills   # rebuild bundles + splice SKILL.md
bun run check:skills   # CI drift guard — fails if a committed artifact is stale
```

## License

MIT
