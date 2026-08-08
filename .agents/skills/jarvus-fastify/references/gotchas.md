# Common Gotchas

Issues frequently encountered in Fastify development and how to resolve them.

## Configuration Access

### Problem: Using process.env Directly

```typescript
// WRONG - bypasses validation, no type safety
const apiKey = process.env.API_KEY
const port = parseInt(process.env.PORT || '3000')
```

### Solution: Always Use fastify.config

```typescript
// CORRECT - validated at startup, type-safe
const apiKey = fastify.config.API_KEY
const port = fastify.config.PORT
```

In services, access config through the fastify instance:

```typescript
export class MyService {
  constructor(private fastify: FastifyInstance) {}

  async doWork() {
    // Access config through fastify, never process.env
    const apiKey = this.fastify.config.API_KEY
  }
}
```

---

## Server Ready State

### Problem: Accessing Config Before Ready

```typescript
// WRONG - config may not be loaded yet
const server = Fastify({ ... })
server.register(app)
console.log(server.config.PORT)  // undefined or error
```

### Solution: Wait for server.ready()

```typescript
// CORRECT
const server = Fastify({ ... })
server.register(app)

const start = async () => {
  await server.ready()  // Wait for plugins to load
  const port = server.config.PORT  // Now safe to access
  await server.listen({ port, host: server.config.HOST })
}

start()
```

---

## Plugin Registration Order

### Problem: Routes Registered Before Dependencies

```typescript
// WRONG - routes can't access services
export const app: FastifyPluginAsync = async (fastify, opts) => {
  await fastify.register(userRoutes)  // Error: userService undefined
  await fastify.register(envPlugin)
  fastify.decorate('userService', new UserService(fastify))
}
```

### Solution: Correct Registration Order

```typescript
// CORRECT - env → services → routes
export const app: FastifyPluginAsync = async (fastify, opts) => {
  // 1. Environment configuration FIRST
  await fastify.register(envPlugin)

  // 2. Initialize services
  const userService = new UserService(fastify)
  fastify.decorate('userService', userService)

  // 3. Register routes LAST
  await fastify.register(userRoutes)
}
```

---

## App Architecture

### Problem: Factory Function Instead of Plugin

```typescript
// WRONG - harder to compose and test
export async function buildApp() {
  const fastify = Fastify({ ... })
  // setup...
  return fastify
}
```

### Solution: Use FastifyPluginAsync Pattern

```typescript
// CORRECT - composable plugin pattern
export const app: FastifyPluginAsync = async (fastify, opts) => {
  // Plugin logic here
}

export default fp(app, '5.x')

// In index.ts
const server = Fastify({ logger: { ... } })
server.register(app)
```

---

## Route Prefix Consistency

### Problem: Inconsistent API Paths

```typescript
// WRONG - mixing prefixed and non-prefixed
fastify.get('/health', ...)           // /health
fastify.get('/api/users', ...)        // /api/users
await fastify.register(routes, { prefix: '/api' })  // Confusing
```

### Solution: Consistent Prefix Strategy

```typescript
// CORRECT - all API routes under /api
await fastify.register(healthRoutes, { prefix: '/api/health' })
await fastify.register(userRoutes, { prefix: '/api/users' })
await fastify.register(orderRoutes, { prefix: '/api/orders' })
```

---

## Path Handling

### Problem: Inconsistent Path Normalization

```typescript
// WRONG - duplicated path logic, inconsistent handling
// In route A:
const fullPath = library ? `${library}/${path}` : path

// In route B:
const fullPath = library + '/' + path

// In route C:
const fullPath = [library, path].filter(Boolean).join('/')
```

### Solution: Centralized Path Utilities

```typescript
// src/utils/path-utils.ts
import path from 'path'

export function trimSlashes(p: string): string {
  return p.replace(/^\/+|\/+$/g, '')
}

export function normalizePath(basePath: string | undefined, filePath: string): string {
  const normalizedBase = basePath && basePath !== '/' ? trimSlashes(basePath) : ''
  const normalizedFile = trimSlashes(filePath)

  if (!normalizedBase) {
    return normalizedFile
  }

  return path.join(normalizedBase, normalizedFile)
}

// Use everywhere:
import { normalizePath } from '../utils/path-utils'
const fullPath = normalizePath(library, path)
```

---

## Object Enumeration

### Problem: Object.entries() Missing Properties

```typescript
// WRONG - may miss properties on some objects
const children = await someLibrary.getChildren()
for (const [name, child] of Object.entries(children)) {
  // May not enumerate all properties
}
```

### Solution: Use for...in for External Objects

```typescript
// CORRECT - enumerates all enumerable properties
const children = await someLibrary.getChildren()
for (const name in children) {
  const child = children[name]
  // Processes all properties
}
```

---

## Schema Drift

### Problem: Swagger Schema Out of Sync

```typescript
// Schema says one thing...
schema: {
  response: {
    200: {
      properties: {
        id: { type: 'string' },
        name: { type: 'string' }
      }
    }
  }
}

// ...but implementation returns something else
return {
  id: item.id,
  name: item.name,
  createdAt: item.createdAt  // Not in schema!
}
```

### Solution: Keep Schemas in Sync

1. Define response types that match schemas
2. Use TypeScript to enforce consistency
3. Test actual responses against schemas

```typescript
interface ItemResponse {
  id: string
  name: string
  createdAt: string
}

// Schema matches the type
schema: {
  response: {
    200: {
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        createdAt: { type: 'string' }
      }
    }
  }
}

// Implementation returns typed response
const response: ItemResponse = {
  id: item.id,
  name: item.name,
  createdAt: item.createdAt.toISOString()
}
return response
```

---

## Logging Noise

### Problem: Health Checks Flooding Logs

```typescript
// Every health check probe logs:
// [12:00:01] incoming request GET /api/health
// [12:00:01] request completed 200
// [12:00:02] incoming request GET /api/health
// [12:00:02] request completed 200
// ... repeated every second
```

### Solution: Filter Health Checks from Logging

```typescript
fastify.addHook('onRequest', (req, reply, done) => {
  // Skip logging for health checks
  if (req.raw.url?.startsWith('/api/health')) {
    done()
    return
  }

  req.log.info({ /* request details */ }, 'incoming request')
  done()
})

fastify.addHook('onResponse', (req, reply, done) => {
  if (req.raw.url?.startsWith('/api/health')) {
    done()
    return
  }

  req.log.info({ /* response details */ }, 'request completed')
  done()
})
```

---

## Error Handling

### Problem: Unhandled Errors Crash Server

```typescript
// WRONG - unhandled promise rejection
fastify.get('/data', async (request, reply) => {
  const data = await externalApi.fetch()  // May throw
  return data
})
```

### Solution: Proper Error Handling

```typescript
// CORRECT - handle errors gracefully
fastify.get('/data', async (request, reply) => {
  try {
    const data = await externalApi.fetch()
    return { success: true, data }
  } catch (error) {
    request.log.error(error, 'Failed to fetch data')
    reply.code(500)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
})
```

---

## Service Dependencies

### Problem: Circular Service Dependencies

```typescript
// WRONG - circular dependency
class ServiceA {
  constructor(private serviceB: ServiceB) {}
}

class ServiceB {
  constructor(private serviceA: ServiceA) {}
}

// Can't instantiate either first
```

### Solution: Use Setter Injection

```typescript
// CORRECT - setter injection breaks the cycle
class ServiceA {
  private serviceB: ServiceB | null = null

  constructor(private fastify: FastifyInstance) {}

  setServiceB(serviceB: ServiceB) {
    this.serviceB = serviceB
  }
}

class ServiceB {
  constructor(private fastify: FastifyInstance) {}
}

// In app.ts
const serviceA = new ServiceA(fastify)
const serviceB = new ServiceB(fastify)
serviceA.setServiceB(serviceB)
```

---

## TypeScript Declaration Merging

### Problem: TypeScript Doesn't Know About Decorations

```typescript
// Error: Property 'userService' does not exist on type 'FastifyInstance'
const user = await fastify.userService.findById(id)
```

### Solution: Declare Module Augmentation

```typescript
// At the top of app.ts or in a types file
declare module 'fastify' {
  interface FastifyInstance {
    userService: UserService
    config: {
      PORT: number
      HOST: string
      // ... all config properties
    }
  }
}
```

---

## Async Hook Short-Circuit Under Bun `.inject()`

### Problem: The Handler Runs After the Hook's 401

```typescript
// WRONG - looks correct, silently fails to short-circuit
fastify.addHook('preHandler', async (req, reply) => {
  const ok = await authorize(req)
  if (!ok) {
    reply.code(401).send({ error: 'unauthorized' })
    return  // ...but the route handler STILL runs
  }
})
```

An async hook that calls `reply.send()` and returns does **not** reliably stop the
request — observed in anger via `.inject()` on Bun: the 401 is in flight, yet the route
handler executes anyway. Fastify only auto-relays a *route handler's* return value; for
hooks, completion signaling through the async return path is runtime-dependent. This is
a silent **authorization-bypass class of bug**: tests may see the 401 status while the
protected side effect still happened.

### Solution: Callback-Style Hook, done() Only on the Allow Path

```typescript
// CORRECT - done() is the only way the chain continues
fastify.addHook('preHandler', (req, reply, done) => {
  authorize(req, reply)
    .then((shouldContinue) => {
      if (shouldContinue) done()
      // else: the reply was already sent - do NOT call done(), which
      // would resume the chain and run the handler after the reply.
    })
    .catch((err) => done(err as Error))
})
```

Register security-critical hooks callback-style `(req, reply, done)` and only call
`done()` on the allow path — never after a reply has been sent. Add a test asserting
the handler did NOT run (e.g. a spy on the downstream side effect), not just that the
status code was 401.

---

## Environment Variable Parsing Footguns

### Problem: Silently Wrong Numbers and Booleans

```typescript
// WRONG - all of these pass silently with garbage input
const port = Number(process.env.PORT)          // "abc" -> NaN, listen() fails cryptically
const ttl = parseInt(process.env.TTL ?? '')    // "3600abc" -> 3600, "-5" -> -5
const debug = process.env.DEBUG === 'true'     // "TRUE", "1", "ture" all -> false, silently
```

`Number()` accepts `NaN` without complaint; `parseInt` truncates trailing garbage and
accepts negatives; a `=== 'true'` boolean check turns any typo into a silent mode
selection. Each surfaces far from the bad env var — as a broken `listen()`, an
immediately-expired session, or the wrong auth mode.

### Solution: Strict Parses That Throw at Boot

```typescript
// CORRECT - digit-only match, range check, named error
function resolvePort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT
  if (raw === undefined || raw.trim() === '') return 8080
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`PORT must be a positive integer (got "${raw}")`)
  }
  const port = parseInt(trimmed, 10)
  if (port < 1 || port > 65535) {
    throw new Error(`PORT must be between 1 and 65535 (got "${raw}")`)
  }
  return port
}

// CORRECT - strict tri-state boolean: unset, true-ish, false-ish; anything else throws
const TRUE_VALUES = new Set(['1', 'true', 'yes'])
const FALSE_VALUES = new Set(['', '0', 'false', 'no'])

function parseBoolEnv(name: string, raw: string | undefined): boolean {
  if (raw === undefined) return false
  const value = raw.trim().toLowerCase()
  if (TRUE_VALUES.has(value)) return true
  if (FALSE_VALUES.has(value)) return false
  throw new Error(`${name} must be one of 1/true/yes or 0/false/no (got "${raw}")`)
}
```

The tri-state parse matters most on security-relevant flags: a typo'd value must
**throw** rather than silently picking a mode (a typo that quietly disabled auth would
be dangerous; one that quietly required it would be confusing).

---

## Accepted-but-Unenforced Config Knobs

### Problem: Parsed Config That Silently Does Nothing

```typescript
// Config schema accepts SESSION_IDLE_TIMEOUT, the code parses and stores it...
sessionIdleTimeoutSeconds: parseIntEnv('SESSION_IDLE_TIMEOUT', env.SESSION_IDLE_TIMEOUT)
// ...but nothing enforces it yet. An operator sets it expecting idle
// logout and gets a silent no-op with no indication anything is missing.
```

This happens naturally when config is wired ahead of the feature (spec'd but deferred).
Rejecting the var breaks forward compatibility; accepting it silently misleads the
operator.

### Solution: Loud Boot Warning for Every Set-but-Unenforced Knob

```typescript
export function unenforcedConfigWarnings(env: NodeJS.ProcessEnv): string[] {
  const warnings: string[] = []
  if (env.SESSION_IDLE_TIMEOUT !== undefined) {
    warnings.push(
      'SESSION_IDLE_TIMEOUT is set but not yet enforced - no idle-timeout logout is applied.'
    )
  }
  return warnings
}

// At boot:
for (const warning of unenforcedConfigWarnings(process.env)) {
  app.log.warn(warning)
}
```

Warn only when the var is **explicitly set** — a default-derived value needs no noise.
Say what is NOT happening ("no absolute session cap is applied"), not just that the
knob is unwired.

---

## Swagger Registration Order

### Problem: Deferred Swagger Register Yields an Empty Spec

```typescript
// WRONG - routes registered before swagger's onRoute hook exists
app.register(fastifySwagger, { openapi: { /* ... */ } })  // not awaited
registerRoutes(app)
// GET /docs/json -> { "paths": {} }  - silently empty, no error anywhere
```

`@fastify/swagger` captures routes via an `onRoute` hook — which only sees routes added
*after* the hook exists. A bare (deferred) `register` queues the plugin behind the route
registration, so every route escapes capture and the document is silently empty.

### Solution: Await Swagger Before Registering Routes

```typescript
// CORRECT
await app.register(fastifySwagger, { openapi: { /* ... */ } })
await app.register(fastifySwaggerUI, { routePrefix: '/docs' })

registerRoutes(app)  // now every route is captured
```

Add a smoke test that injects `GET /docs/json` and asserts `Object.keys(body.paths)`
is non-empty — it catches any future registration reordering.

---

## Testing Considerations

### Problem: Testing Routes Without Full Server

```typescript
// WRONG - starts actual server
const server = await buildApp()
await server.listen({ port: 3000 })
// test...
await server.close()
```

### Solution: Use inject() for Testing

```typescript
// CORRECT - no actual server needed
import { app } from './app'

test('GET /api/health returns healthy', async () => {
  const fastify = Fastify()
  await fastify.register(app)
  await fastify.ready()

  const response = await fastify.inject({
    method: 'GET',
    url: '/api/health'
  })

  expect(response.statusCode).toBe(200)
  expect(JSON.parse(response.body)).toMatchObject({
    status: 'healthy'
  })
})
```
