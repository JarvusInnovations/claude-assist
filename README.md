# claude-assist

Backend services for a Claude-based personal executive assistant. Provides postgres-backed APIs for session recall, email triage, and calendar queries.

## Plugin Installation

Install as a Claude Code plugin to use the session-recall skill:

```
/plugin marketplace add JarvusInnovations/claude-assist
/plugin install claude-assist@jarvus-claude-assist
```

After installation, the `/session-recall` skill becomes available. Use it when you need to search past Claude sessions.

**Note:** The plugin requires a running backend server with PostgreSQL. See [Quick Start](#quick-start) below.

## Prerequisites

- Docker with Compose plugin

## Quick Start

```bash
cd apps/server
docker compose up --build -d
```

The API will be available at <http://localhost:3000>

Sessions from `~/.claude/` on the host machine sync automatically. To sync from other machines:

```bash
bunx @jarvus/claude-assist-sessions push -m laptop -s https://your-server:3000
```

## Local Development

For contributors who want to develop locally with hot reload:

```bash
# Install bun via asdf (uses .tool-versions)
asdf install

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
  session-recall/  # Session search skill
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

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |
| HOST | 0.0.0.0 | Server host |
| DATABASE_URL | postgres://claude:dev@localhost:5432/claude_assist | PostgreSQL connection |
| LOG_LEVEL | info | Log level (debug, info, warn, error) |
| NODE_ENV | development | Environment (development, production) |

## Skills

Skills are loaded on-demand by Claude. Available skills:

- **session-recall** - Search past Claude sessions

See `skills/*/SKILL.md` for usage documentation.

## License

MIT
