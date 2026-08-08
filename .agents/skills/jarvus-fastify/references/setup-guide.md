# Fastify Backend Setup Guide (Bun)

This guide documents the complete process for bootstrapping a Fastify backend on **Bun**.
Bun is the runtime, package manager, test runner, and watch-mode dev server — there is no
Node.js, npm, or tsx, and no compile step in the dev loop or in production.

## Prerequisites

- Bun (latest)

### Bun Version Management with asdf

Use [asdf](https://asdf-vm.com/) to manage Bun consistently across the team:

```bash
# Install Bun plugin (one-time setup)
asdf plugin add bun

# Pin Bun for the project (creates .tool-versions)
asdf set bun latest
asdf install
```

The `.tool-versions` file created by `asdf set` ensures all team members use the same Bun
version. Add `nodejs` only if the repo also ships an npm-distributed CLI.

## Stack Overview

- **Bun** - Runtime, package manager, test runner, watch-mode dev server
- **Fastify 5.x** - High-performance web framework
- **TypeScript** - Type safety, executed directly by Bun
- **pino-pretty** - Pretty logging for development
- **@fastify/env** - Environment variable validation with JSON Schema
- **@fastify/cors** - CORS support
- **fastify-plugin** - Plugin system

## Step-by-Step Setup

### 1. Initialize Backend Package

```bash
mkdir -p backend && cd backend
bun init -y
```

Update `package.json` scripts. Bun runs the source directly, so there is no `build`/`start`
compile dance — `start` just runs the entry point:

```json
{
  "name": "backend",
  "version": "1.0.0",
  "description": "Backend API server",
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "start": "bun run src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  }
}
```

**Commit:** `feat(backend): initialize backend package`

---

### 2. Install Dependencies

```bash
bun add fastify fastify-plugin @fastify/env @fastify/cors pino-pretty
bun add -d typescript @types/bun
```

**Commit:** `build(backend): install Fastify and dependencies`

---

### 3. Create TypeScript Configuration

Bun executes the source directly, so `tsconfig.json` is for **type checking only**
(`"noEmit": true`) — never a build tool.

**Create `tsconfig.json`:**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "types": ["@types/bun"],
    "lib": ["ESNext"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

**Create `.gitignore`:**

```
node_modules/
.env
*.log
.DS_Store
```

**Commit:** `config(backend): add TypeScript configuration and gitignore`

---

### 4. Create Directory Structure

```bash
mkdir -p src/{plugins,routes,services}
```

---

### 5. Create Environment Plugin

**Create `src/plugins/env.ts`:**

```typescript
import fp from 'fastify-plugin'
import fastifyEnv from '@fastify/env'

const schema = {
  type: 'object',
  required: [], // Add required env vars here
  properties: {
    PORT: {
      type: 'number',
      default: 3001
    },
    HOST: {
      type: 'string',
      default: '0.0.0.0'
    },
    NODE_ENV: {
      type: 'string',
      enum: ['development', 'production', 'test'],
      default: 'development'
    },
    LOG_LEVEL: {
      type: 'string',
      enum: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
      default: 'info'
    },
  }
}

// TypeScript declaration merging for type safety
declare module 'fastify' {
  interface FastifyInstance {
    config: {
      PORT: number
      HOST: string
      NODE_ENV: 'development' | 'production' | 'test'
      LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
    }
  }
}

export default fp(async (fastify) => {
  await fastify.register(fastifyEnv, {
    schema,
    dotenv: true // Load .env file
  })
})
```

**Create `.env.example`:**

```
PORT=3001
HOST=0.0.0.0
NODE_ENV=development
LOG_LEVEL=info
```

**Key patterns:**

- JSON Schema validation ensures type safety at startup
- Declaration merging provides TypeScript type safety
- `dotenv: true` automatically loads `.env` file
- Failed validation prevents server from starting

**When JSON Schema isn't enough.** `@fastify/env` validates each variable in isolation —
JSON Schema cannot express:

- **Cross-field contracts** — "exactly one of `OIDC_ISSUER_URL` or `AUTH_DISABLED=1`
  must be set; both or neither is a boot error"
- **Environment-detection guards** — "refuse to boot if `AUTH_DISABLED` is set while
  Cloud Run markers (`K_REVISION`) are present"
- **Strict tri-state booleans** — unset / true-ish / false-ish, where a typo'd value
  throws instead of silently picking a mode (schema `enum` gets close, but not the
  "unset means X" + normalization + custom error message combination)
- **Value-quality checks with actionable errors** — "must be a well-formed https URL",
  "signing key must be ≥32 bytes because HS256 requires a 256-bit key"

For those, write a plain `resolveConfig(env: NodeJS.ProcessEnv)` function that throws
with an **actionable message** (name the variable, show the offending value, say what
would fix it) and call it at boot before anything else. Keep `@fastify/env` for the
simple per-variable cases; hand-rolled fail-fast validation is the right tool for the
contracts above — not a workaround. See gotchas.md "Environment Variable Parsing
Footguns" for the strict number/boolean parses.

**Commit:** `feat(backend): add environment configuration plugin`

---

### 6. Create a Basic Service

Services encapsulate business logic and are decorated onto the Fastify instance.

**Example `src/services/example-service.ts`:**

```typescript
import { FastifyInstance } from 'fastify'

export class ExampleService {
  constructor(private fastify: FastifyInstance) {}

  // Service methods here
  async doSomething() {
    this.fastify.log.info('Service method called')
    return { success: true }
  }
}
```

---

### 7. Create Routes

Routes are Fastify plugins that define HTTP endpoints.

**Create `src/routes/health.ts`:**

```typescript
import { FastifyPluginAsync } from 'fastify'

const healthRoutes: FastifyPluginAsync = async (fastify, opts) => {
  fastify.get('/', async (request, reply) => {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'backend-service',
      version: '1.0.0',
      environment: fastify.config.NODE_ENV
    }
  })
}

export default healthRoutes
```

**Commit:** `feat(backend): add health check route`

---

### 8. Create app.ts

The app file registers all plugins, services, and routes.

**Create `src/app.ts`:**

```typescript
import { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import cors from '@fastify/cors'

// Import plugins
import envPlugin from './plugins/env'

// Import services
import { ExampleService } from './services/example-service'

// Import routes
import healthRoutes from './routes/health'

// TypeScript declaration merging for services
declare module 'fastify' {
  interface FastifyInstance {
    exampleService: ExampleService
  }
}

export const app: FastifyPluginAsync = async (fastify, opts) => {
  // 1. Register environment configuration FIRST
  await fastify.register(envPlugin)

  // Update log level from config
  fastify.log.level = fastify.config.LOG_LEVEL

  // 2. Initialize services
  const exampleService = new ExampleService(fastify)

  // 3. Decorate fastify instance with services
  fastify.decorate('exampleService', exampleService)

  // 4. Register CORS
  await fastify.register(cors, {
    origin: fastify.config.NODE_ENV === 'production' ? false : true,
    credentials: true
  })

  // 5. Add custom logging hooks (excluding health checks)
  fastify.addHook('onRequest', (req, reply, done) => {
    if (req.raw.url?.startsWith('/api/health')) {
      done()
      return
    }

    req.log.info({
      reqId: req.id,
      req: {
        method: req.raw.method,
        url: req.raw.url,
        host: req.headers.host,
        remoteAddress: req.ip
      }
    }, 'incoming request')
    done()
  })

  fastify.addHook('onResponse', (req, reply, done) => {
    if (req.raw.url?.startsWith('/api/health')) {
      done()
      return
    }

    req.log.info({
      reqId: req.id,
      res: { statusCode: reply.statusCode },
      responseTime: reply.elapsedTime
    }, 'request completed')
    done()
  })

  // 6. Register routes with /api prefix
  await fastify.register(healthRoutes, { prefix: '/api/health' })

  // 7. Log successful startup
  fastify.addHook('onReady', async () => {
    fastify.log.info('Backend initialized successfully')
    fastify.log.info(`Environment: ${fastify.config.NODE_ENV}`)
    fastify.log.info('Available API endpoints:')
    fastify.log.info('  GET /api/health - Health check')
  })
}

export default fp(app, '5.x')
```

**Key patterns:**

- Register env plugin FIRST before anything else
- Initialize services and decorate Fastify instance for type-safe access
- Custom logging hooks skip health checks to reduce noise
- Routes registered with `/api` prefix
- `onReady` hook logs startup info

**Commit:** `feat(backend): add app.ts with plugin registration`

---

### 9. Create index.ts Entry Point

**Create `src/index.ts`:**

```typescript
import Fastify from 'fastify'
import { app } from './app'

const server = Fastify({
  logger: {
    level: 'info', // Will be updated after env config loads
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname'
      }
    }
  },
  disableRequestLogging: true // We use custom hooks in app.ts
})

// Register the app
server.register(app)

// Graceful shutdown handlers
const gracefulShutdown = async (signal: string) => {
  server.log.info(`Received ${signal}, shutting down gracefully`)
  try {
    await server.close()
    server.log.info('Server closed successfully')
    process.exit(0)
  } catch (error) {
    server.log.error(error, 'Error during shutdown')
    process.exit(1)
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// Start the server
const start = async () => {
  try {
    // Wait for ready so env config is loaded
    await server.ready()

    const port = server.config.PORT
    const host = server.config.HOST

    await server.listen({ port, host })

    server.log.info(`Backend listening at http://${host}:${port}`)
    server.log.info(`Environment: ${server.config.NODE_ENV}`)

    if (server.config.NODE_ENV !== 'production') {
      server.log.info(`API endpoints: http://localhost:${port}/api/`)
      server.log.info(`Health check: http://localhost:${port}/api/health`)
    }
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()
```

**Key patterns:**

- pino-pretty for readable dev logs
- `disableRequestLogging: true` because we use custom hooks
- Graceful shutdown handlers for SIGTERM/SIGINT
- `await server.ready()` before accessing config
- Pretty startup logging

**Commit:** `feat(backend): add index.ts entry point with graceful shutdown`

---

## Running the Backend

```bash
# Development with watch mode
bun run dev

# Run the server (no build step — Bun executes the source)
bun run start

# Type check only
bun run typecheck

# Tests
bun test
```

---

## VSCode Debugging

Configure VSCode to debug the backend with breakpoints, variable inspection, and step-through execution. Bun ships a VSCode debug adapter — install the **Bun for Visual Studio Code** extension (`oven.bun-vscode`).

### Launch Configuration

**Create `.vscode/launch.json`:**

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Backend",
      "type": "bun",
      "request": "launch",
      "program": "${workspaceFolder}/backend/src/index.ts",
      "cwd": "${workspaceFolder}/backend",
      "watchMode": true,
      "envFile": "${workspaceFolder}/backend/.env",
      "internalConsoleOptions": "neverOpen"
    }
  ]
}
```

**Key patterns:**

- `type: "bun"` uses Bun's debug adapter to run TypeScript source directly — no pre-compilation, no source maps to wire up
- `watchMode: true` reloads on change while debugging
- `envFile` loads environment variables from `.env` file
- pino-pretty formatted logs appear in the integrated terminal

### Using the Debugger

1. **Set breakpoints** - Click the gutter next to line numbers in any `.ts` file
2. **Start debugging** - Press `F5` or select "Debug Backend" from the Run and Debug panel
3. **Debug controls** - Use Continue (F5), Step Over (F10), Step Into (F11), Step Out (Shift+F11)
4. **Inspect variables** - Hover over variables or use the Variables panel

**Commit:** `config(backend): add VSCode debugging configuration`

---

## Vite Proxy Configuration (Frontend Integration)

To proxy frontend API requests to the backend during development:

**Update `vite.config.ts`:**

```typescript
export default defineConfig({
  // ... other config
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
})
```

**Commit:** `config: add Vite proxy for backend API requests`

---

## Serving a Built SPA

When the backend also serves the frontend's production build (one deployable unit),
use `@fastify/static` plus an index.html not-found fallback:

```bash
bun add @fastify/static
```

```typescript
// In index.ts, after routes are registered
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import path from 'node:path'

const uiDist = process.env.UI_DIST_PATH ?? path.join(import.meta.dir, 'ui', 'dist')
if (existsSync(uiDist)) {
  app.register(fastifyStatic, { root: uiDist })
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.sendFile('index.html')
    }
    reply.status(404)
    return { error: 'not found' }
  })
} else {
  app.log.warn(`UI dist not found at ${uiDist} — serving API only`)
}
```

**Key patterns:**

- **API routes win by specificity** — the router prefers the more specific `/api/*`
  routes over the static plugin's wildcard route, so no ordering tricks are needed
- **The index.html fallback is REQUIRED, not a convenience** — an SPA with
  browser/history routing means every deep link and refresh to a client route
  (e.g. `/run/123`) misses the static files and must boot the SPA from `index.html`;
  API misses still get a JSON 404
- **Graceful API-only mode** — when the dist dir is absent (dev, or a backend-only
  build) the server logs a warning and runs API-only instead of crashing; local
  frontend dev uses the Vite proxy above

**Interaction with a global auth hook:** the static plugin registers a wildcard route,
so the global auth gateway DOES see every static-asset request — they don't bypass
hooks. Your anonymous allowlist must therefore cover safe-method (GET/HEAD) requests
outside the API and auth namespaces, or the SPA shell can never load for an
anonymous visitor who needs it to reach the login redirect. See authentication.md
"The Anonymous Allowlist" — the shell is safe to serve anonymously because it contains
no data; everything it renders comes from the authenticated API.

**Commit:** `feat(backend): serve built SPA with history-routing fallback`

---

## Key Fastify Patterns

### Service Pattern

```typescript
// 1. Create service class
export class MyService {
  constructor(private fastify: FastifyInstance) {}

  async doWork() {
    // Access config: this.fastify.config.SOME_VAR
    // Access logger: this.fastify.log.info('...')
  }
}

// 2. Declare module augmentation
declare module 'fastify' {
  interface FastifyInstance {
    myService: MyService
  }
}

// 3. Initialize and decorate in app.ts
const myService = new MyService(fastify)
fastify.decorate('myService', myService)

// 4. Use in routes
fastify.get('/example', async (request, reply) => {
  return fastify.myService.doWork()
})
```

### Route Pattern

```typescript
import { FastifyPluginAsync } from 'fastify'

const routes: FastifyPluginAsync = async (fastify, opts) => {
  fastify.get('/', async (request, reply) => {
    return { data: 'example' }
  })

  fastify.post<{ Body: MyType }>('/', async (request, reply) => {
    const { field } = request.body
    return { success: true }
  })
}

export default routes
```

### Plugin Pattern

```typescript
import fp from 'fastify-plugin'

export default fp(async (fastify, opts) => {
  // Plugin logic here
  fastify.decorate('something', value)
}, '5.x') // Fastify version constraint
```

---

## Common Gotchas

### Environment Variables Must Be Declared

All env vars must be in the schema or they won't be accessible. Use `required: []` array for mandatory vars.

### Services Need Declaration Merging

Without declaration merging, TypeScript won't know about decorated services.

### Plugin Registration Order Matters

Always register env plugin first, then services, then routes.

### Use await server.ready()

Access `server.config` only after `await server.ready()` in index.ts.

### Logging Hooks vs Built-in Logging

Use `disableRequestLogging: true` and custom hooks to control what gets logged.

---

## Project Structure

```
backend/
├── src/
│   ├── plugins/
│   │   └── env.ts           # Environment config with validation
│   ├── routes/
│   │   └── health.ts        # HTTP endpoints
│   ├── services/
│   │   └── example-service.ts  # Business logic
│   ├── app.ts               # Plugin registration & setup
│   └── index.ts             # Server entry point
├── node_modules/            # Dependencies (gitignored)
├── package.json
├── bun.lock                 # Lockfile (committed)
├── tsconfig.json
├── .env                     # Environment variables (gitignored)
├── .env.example             # Template for .env
└── .gitignore
```

---

## Additional Resources

- [Fastify Documentation](https://fastify.dev/)
- [Pino Logger](https://getpino.io/)
- [JSON Schema](https://json-schema.org/)
