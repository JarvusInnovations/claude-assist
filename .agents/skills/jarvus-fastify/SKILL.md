---
name: jarvus-fastify
description: Backend development using Fastify + TypeScript on Bun. Use when creating new backend APIs, adding routes, implementing services, working with plugins, or configuring environment variables.
---

# Backend Fastify Stack (Bun)

High-performance backend stack, run on **Bun**:

- **Bun** - Runtime, package manager, test runner, and watch-mode dev server (no Node.js, npm, or tsx)
- **Fastify 5.x** - Web framework
- **TypeScript** - Type safety, executed directly by Bun (no build step for services)
- **pino-pretty** - Pretty logging for development
- **@fastify/env** - Environment variable validation with JSON Schema
- **@fastify/cors** - CORS support
- **fastify-plugin** - Plugin system

Bun runs TypeScript source directly, so there is **no compile step** in the dev loop and
none in production for a service — you ship and run the source. `tsc` is kept only as a
type checker (`tsc --noEmit`), never as a build tool.

## Environment Setup

Use [asdf](https://asdf-vm.com/) to manage Bun:

```bash
# Install the Bun plugin (one-time)
asdf plugin add bun

# Pin Bun for the project (writes .tool-versions)
asdf set bun latest
asdf install
```

This writes a `.tool-versions` file pinning Bun so the whole team runs the same version.
A born-on-Bun service needs **only** `bun` in `.tool-versions` — add `nodejs` only if the
repo also ships an npm-distributed CLI that needs the Node toolchain.

## Reference Files

| File | When to Use |
| ------ | ------------- |
| [setup-guide.md](references/setup-guide.md) | Starting a new backend project from scratch |
| [patterns.md](references/patterns.md) | Implementing routes, services, schema validation |
| [authentication.md](references/authentication.md) | Auth: deny-by-default gateway, sessions, tokens, OIDC, local dev mode |
| [api-design.md](references/api-design.md) | Swagger/OpenAPI integration, response format, errors |
| [mcp-integration.md](references/mcp-integration.md) | Integrating MCP server for AI agent access |
| [gotchas.md](references/gotchas.md) | Debugging issues, common mistakes and fixes |

## Quick Reference

### Commands

```bash
# Dev server with watch mode (Bun reloads on change)
bun run dev          # → bun --watch src/index.ts

# Type check (no emit — Bun runs the source, tsc only checks types)
bun run typecheck    # → tsc --noEmit

# Run the server (no build needed — Bun executes the source)
bun run start        # → bun run src/index.ts

# Tests (Bun's built-in runner)
bun test
```

### Package Management

Use **Bun** for all dependency management — never edit `package.json` by hand:

```bash
bun add fastify-plugin @fastify/cors        # runtime deps
bun add -d @types/bun pino-pretty           # dev deps
bun remove <pkg>                            # remove
```

`bun add` resolves the latest compatible version and keeps `bun.lock` in sync. Commit
`bun.lock`.

### Key Imports

```typescript
// Fastify types
import Fastify, { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

// Common plugins
import fastifyEnv from '@fastify/env'
import cors from '@fastify/cors'
```

### Configuration Access

Always access configuration through `fastify.config`, never `process.env` directly:

```typescript
// CORRECT - type-safe, validated at startup
const port = fastify.config.PORT
const apiKey = fastify.config.API_KEY

// WRONG - no validation, no type safety
const port = process.env.PORT  // Don't do this
```

`@fastify/env`'s JSON Schema covers per-variable shape validation. When config needs
cross-field contracts ("exactly one of these two modes"), environment-detection guards,
or strict tri-state booleans, hand-rolled fail-fast validation at boot is the right tool
— see setup-guide.md "When JSON Schema isn't enough".

### Response Format

Pick one convention per API and stick to it. The envelope below is one option; structured
domain-specific bodies (e.g. `{error: "forbidden", required, environment, your_role}`) are
equally valid and often spec-mandated — see [api-design.md](references/api-design.md).

```typescript
// The envelope option
{
  success: boolean
  data?: T
  error?: string
  metadata?: { timestamp: Date }
}
```

### Plugin Pattern

```typescript
import fp from 'fastify-plugin'

export default fp(async (fastify, opts) => {
  // Plugin logic here
  fastify.decorate('something', value)
}, '5.x')
```

### Route Pattern

```typescript
import { FastifyPluginAsync } from 'fastify'

const routes: FastifyPluginAsync = async (fastify, opts) => {
  fastify.get('/', async (request, reply) => {
    return { success: true, data: 'example' }
  })
}

export default routes
```

### Service Pattern

```typescript
// 1. Create service class
export class MyService {
  constructor(private fastify: FastifyInstance) {}

  async doWork() {
    // Access config through fastify instance
    const apiKey = this.fastify.config.API_KEY
    this.fastify.log.info('Service method called')
  }
}

// 2. Declare module augmentation
declare module 'fastify' {
  interface FastifyInstance {
    myService: MyService
  }
}

// 3. Initialize and decorate in app.ts
fastify.decorate('myService', new MyService(fastify))
```

### TypeScript Config

Bun runs the source directly, so `tsconfig.json` is for **type checking only**
(`"noEmit": true`). The Bun-native config:

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",          // let Bun own module resolution
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "types": ["@types/bun"],        // Bun globals (Bun.file, Bun.serve, etc.)
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

In a **Bun-workspaces monorepo**, the package tsconfigs use TypeScript project references
(`"composite": true`, per-package `references`) and the root runs `tsc -b`; the runtime
story is unchanged — Bun still executes the source.

### Project Structure

```
backend/
├── src/
│   ├── plugins/          # Fastify plugins (env, auth, etc.)
│   ├── routes/           # HTTP route handlers
│   ├── services/         # Business logic classes
│   ├── lib/              # Shared utilities / clients
│   ├── app.ts            # Plugin registration & setup
│   └── index.ts          # Server entry point
├── package.json
├── tsconfig.json
├── .env.example
└── .gitignore
```

### Common Gotchas

- **Plugin order matters**: Register env plugin first, then services, then routes
- **Config access**: Use `fastify.config.VAR` not `process.env.VAR`
- **Server ready**: Call `await server.ready()` before accessing config in index.ts
- **No build step**: Bun runs the source; `tsc` is `--noEmit` for type checking only
- **Path normalization**: Centralize path utilities, handle root '/' as special case
- **Package management**: Use `bun add <pkg>` not manual `package.json` edits

## CI & Code Quality

Wire lint, format, and type-check into CI from the start. The cross-cutting setup (asdf
provisioning + caching, path-filtered workflows, lockfile-frozen installs, the GitHub Actions
templates) lives in the **`ci-quality-gates`** skill; this section is the Fastify-stack
specifics that plug into it.

**Linter + formatter: oxlint + oxfmt** (the Jarvus standard — not eslint/prettier):

```bash
bun add -d oxlint oxfmt
```

**The script contract.** Expose the same four scripts every Jarvus TS package does, so CI
just calls `bun run <name>`:

```jsonc
{
  "scripts": {
    "dev":          "bun --watch src/index.ts",
    "start":        "bun run src/index.ts",
    "typecheck":    "tsc --noEmit",
    "lint":         "oxlint index.ts src",
    "format":       "oxfmt index.ts src",
    "format:check": "oxfmt --check index.ts src",
    "test":         "bun test"
  }
}
```

Use the **base** oxc config (`references/templates/oxlintrc.base.json` from `ci-quality-gates`,
correctness=error) as the service's `.oxlintrc.json` — backend code doesn't need the React
tier. In a Bun-workspaces monorepo, put the base config at the repo root as
`.oxlintrc.base.json` and have each package extend it; a service that contains a UI subfolder
adds `"ignorePatterns": ["ui"]` so the UI is linted by its own config.

**CI workflow.** A single service uses one `ts-lint`-style job (`lint` + `format:check` +
`typecheck`) plus a `test` job; a monorepo uses the per-package matrix in `ci-quality-gates`'s
`lint.yml` / `test.yml`. All provisioned by the shared `setup-asdf` composite. Type-check is a
required gate — `tsc --noEmit` catches bugs no linter does.
