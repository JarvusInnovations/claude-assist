# claude-assist

Backend services for a Claude-based personal executive assistant. Provides postgres-backed APIs for session recall, email triage, and calendar queries.

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- Docker (for PostgreSQL)

## Quick Start

```bash
# Install dependencies
bun install

# Start PostgreSQL
cd apps/server
docker-compose up postgres -d

# Start development server
bun run dev
```

The API will be available at <http://localhost:3000>

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
# Start PostgreSQL only
cd apps/server
docker-compose up postgres -d

# Start full stack
docker-compose up -d

# View logs
docker-compose logs -f
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
