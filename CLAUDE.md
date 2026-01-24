# claude-assist

Backend services for Hari: session recall, email triage, calendar queries.

## Development

Use **Bun** throughout:

- `bun install` - install dependencies
- `bun run build` - build all packages
- `bun run dev` - start development server
- `bun test` - run tests

## Structure

```
packages/
  core/       - Shared utilities (scheduler, migrations, search)
  sessions/   - Session archive module (Phase 2)
  google/     - Google Suite module (Phase 3)
apps/
  server/     - Fastify host application
skills/
  session-recall/  - Session search skill
```

## Conventions

- Packages use `@claude-assist/` namespace
- Each module is a Fastify plugin
- Database: PostgreSQL with schema-per-module
- Skills follow official Claude SKILL.md format
