# claude-assist

Backend services for Hari (personal executive assistant). Bun monorepo with Fastify + PostgreSQL.

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

For workspace dependencies: `"@claude-assist/core": "workspace:*"`

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
import { createPlugin } from '@claude-assist/core';

export default createPlugin('mymodule', async (fastify, options) => {
  // Register routes, scheduled tasks, etc.
});
```

- Packages use `@claude-assist/` namespace
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
| `apps/server/src/server.ts` | Main application entry |
