# claude-assist

Backend services for Claude-based personal assistants. Bun monorepo with Fastify + PostgreSQL.

## Commands

```bash
bun install              # Install all workspace deps
bun run build            # Build all packages
bun run dev              # Start server with watch mode
bun test                 # Run tests
```

## Package Management

**NEVER manually edit package.json for dependencies.** Always use:

```bash
bun add <pkg>            # Runtime dependency
bun add -d <pkg>         # Dev dependency
bun add -p <pkg>         # Peer dependency
```

For workspace dependencies: `"@jarvus/claude-assist-core": "workspace:*"`

## Structure

```
packages/
  core/        # Shared: scheduler, migrations, search, plugin helpers
  sessions/    # Session archive module (Phase 2)
  google/      # Google Suite module (Phase 3)
apps/
  server/      # Fastify host application
skills/
  */SKILL.md   # Claude skills (on-demand loaded)
```

## Module Conventions

Each module is a Fastify plugin using `createPlugin()` from core:

```typescript
import { createPlugin } from '@jarvus/claude-assist-core';

export default createPlugin('mymodule', async (fastify, options) => {
  // Register routes, scheduled tasks, etc.
});
```

- Packages use `@jarvus/claude-assist-*` namespace
- Schema-per-module in PostgreSQL (e.g., `sessions.`, `google.`)
- Migrations in `migrations/*.sql` (numbered: `001-foo.sql`, `002-bar.sql`)
- Access `fastify.sql` for database, `fastify.scheduler` for tasks

## Skills

Skills use official Claude SKILL.md format with YAML frontmatter:

```markdown
---
name: skill-name
description: When to use this skill
---
# Skill Name
## When to Use
## Quick Start
## Available Endpoints
```

## Commits

Use conventional commits with scope:

- `feat(core): add feature` - new functionality
- `fix(server): fix bug` - bug fixes
- `docs: update readme` - documentation

Co-author line: `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`

## Docker

```bash
cd apps/server
docker-compose up postgres -d    # Database only
docker-compose up -d             # Full stack
```

## Key Files

| File | Purpose |
|------|---------|
| `packages/core/src/scheduler.ts` | Task scheduling with croner |
| `packages/core/src/migrations.ts` | SQL migration runner |
| `packages/core/src/search.ts` | Postgres tsvector helpers |
| `packages/core/src/plugin.ts` | Fastify plugin factory |
| `packages/sessions/src/index.ts` | Session archival plugin |
| `packages/sessions/src/sync.ts` | Sync service for local/satellite ingestion |
| `packages/sessions/src/parser.ts` | JSONL transcript parser |
| `packages/sessions/bin/push.ts` | CLI for satellite machines |
| `apps/server/src/server.ts` | Main application entry |

## Sessions Module (Phase 2)

Archives Claude Code transcripts from `~/.claude/` with multi-machine support.

**Key concepts:**

- Scans `~/.claude/session-signals/*.ended.json` for completed sessions
- Extracts `user_messages`, `tools_used`, `files_touched` from JSONL transcripts
- Stores raw transcript in DB (Claude prunes after ~1 month)
- MD5 hash-based change detection to avoid duplicates

**CLI tool** for satellite machines:

```bash
bunx @jarvus/claude-assist-sessions push --machine laptop --server https://devbox:3000
```

**NPM namespace:** All packages use `@jarvus/claude-assist-*` for both workspace and published names.

## PostgreSQL Patterns

**Weighted full-text search** (search_vector trigger):

```sql
setweight(to_tsvector('english', search_text), 'A') ||       -- User prompts (highest)
setweight(to_tsvector('english', tools_used), 'B') ||        -- Tools/files
setweight(to_tsvector('english', project_path), 'C')         -- Project path
```

**JSONB array containment** - use explicit array syntax with postgres.js:

```typescript
// Correct - explicit ARRAY[]::text[] cast
fastify.sql`AND tools_used ?| ARRAY[${fastify.sql(toolsArray)}]::text[]`

// Wrong - may not serialize correctly
fastify.sql`AND tools_used ?| ${toolsArray}`
```

**Array indexing** - always use `!` assertion after length check:

```typescript
if (rows.length > 0) {
  return rows[0]!;  // TypeScript knows it's defined
}
```

## Scheduler Tasks

Register tasks in plugin setup:

```typescript
fastify.scheduler.register({
  name: 'sessions:sync-local',
  schedule: '*/5 * * * *',  // Every 5 minutes
  runOnStartup: true,
  handler: async () => { /* ... */ },
});
```

## Lessons Learned

- **Silent error swallowing**: Track parse error counts for debugging visibility
- **Timestamp fallbacks**: Derive missing `started_at` from `ended_at`, not `new Date()`
- **PostgreSQL arrays**: Use explicit `ARRAY[]::text[]` cast with `?|` operator
