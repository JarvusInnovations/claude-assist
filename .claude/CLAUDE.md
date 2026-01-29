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
  sessions/    # Session archive with AI outlines (see README.md)
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
- Schema-per-module in PostgreSQL (e.g., `sessions.`)
- Migrations in `migrations/*.sql` (numbered: `001-foo.sql`, `002-bar.sql`)
- Access `fastify.sql` for database, `fastify.scheduler` for tasks

## Skills

Skills use official Claude SKILL.md format with YAML frontmatter. See `skills/*/SKILL.md` for examples.

## Skill Development

When creating or modifying skills, activate the `skill-creator` skill first for guidance on skill structure, frontmatter, and best practices.

### Server URL Placeholder

Skills that make API calls to the claude-assist server use `<claude-assist-server>` as a placeholder in curl examples:

```bash
curl <claude-assist-server>/api/google/emails
```

**Always include this note** in skills that use the placeholder:

> **Note:** Replace `<claude-assist-server>` with the actual server URL (e.g., `http://localhost:2529`). If a request fails with connection refused, ask the user for the correct server endpoint.

## Commits

Use conventional commits with scope:

- `feat(core): add feature` - new functionality
- `fix(server): fix bug` - bug fixes
- `docs: update readme` - documentation

Co-author line: `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`

## Environment Configuration

**NEVER access `process.env` directly in packages.** All env vars are centralized in `apps/server/src/plugins/env.ts` with JSON Schema validation.

In server.ts or plugins with fastify instance, use `fastify.config`:

```typescript
const apiKey = fastify.config.ANTHROPIC_API_KEY;
```

For packages, receive config via plugin options:

```typescript
export default createPlugin('mymodule', async (fastify, options) => {
  const config = options.myModuleConfig;
  // Use config.apiKey, config.concurrency, etc.
});
```

See `apps/server/.env.example` for available configuration. Key optional features:

- `ANTHROPIC_API_KEY` - Enables AI-generated session outlines and email triage
- `SESSIONS_ORIGINAL_CLAUDE_DIR` - Docker path translation
- `SESSIONS_DISABLE_LOCAL_INGEST` - Disable filesystem scanning
- `GOOGLE_DISABLE_EMAIL_SYNC` - Disable Gmail sync
- `GOOGLE_DISABLE_EMAIL_TRIAGE` - Disable AI email triage

## Docker

```bash
cd apps/server
docker-compose up postgres -d    # Database only
docker-compose up -d             # Full stack
```

## Key Patterns

### PostgreSQL with postgres.js

**JSONB array containment** - pass array directly:

```typescript
// Correct - pass array directly, postgres.js handles parameterization
fastify.sql`AND tools_used ?| ${toolsArray}`

// Wrong - nested fastify.sql() treats values as identifiers (column names)
fastify.sql`AND tools_used ?| ARRAY[${fastify.sql(toolsArray)}]::text[]`
```

**Array indexing** - use `!` assertion after length check:

```typescript
if (rows.length > 0) {
  return rows[0]!;  // TypeScript knows it's defined
}
```

**BIGINT handling** - postgres.js returns as string:

```typescript
// Parse explicitly to avoid precision loss
const tokens = parseInt(row.output_tokens, 10);
```

**JSONB writes** - pass objects directly, never use JSON.stringify:

```typescript
// Correct - postgres.js auto-serializes objects to JSONB
sql`UPDATE table SET data = ${myObject}`

// Wrong - double-serializes, stores escaped JSON string
sql`UPDATE table SET data = ${JSON.stringify(myObject)}::jsonb`
```

**JSONB reads** - postgres.js may return as string, parse if needed:

```typescript
function parseJsonField<T>(value: T | string | null): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return null; }
  }
  return value as T;
}
```

### Optional Services

Services requiring external API keys check config and gracefully degrade:

```typescript
// Pattern: service is null if key missing, routes check before exposing
const config = options.sessionsConfig ?? {};

let outlineService: OutlineService | null = null;
if (config.anthropicApiKey) {
  outlineService = new OutlineService(fastify.sql, fastify.log, {
    apiKey: config.anthropicApiKey,
    concurrency: config.outlineConcurrency,
  });
}

if (outlineService) {
  fastify.post('/outlines', ...);
}
```

### Efficient Data Transfer

Two-phase protocol for syncing large datasets:

1. **Inventory phase**: Send lightweight manifest (IDs + MD5 hashes)
2. **Transfer phase**: Server responds with needed items, client sends only those

MD5 hash-based change detection prevents duplicate processing.

### Scheduled Tasks

Register recurring tasks in plugin setup:

```typescript
fastify.scheduler.register({
  name: 'module:task-name',
  schedule: '*/5 * * * *',  // Cron expression
  runOnStartup: true,
  handler: async () => { /* ... */ },
});
```
