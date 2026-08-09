# MCP Server Integration

Patterns for integrating a Model Context Protocol (MCP) server with Fastify backends.

## Overview

MCP enables AI agents to interact with your backend through a standardized protocol. This guide covers integrating MCP using the `fastify-mcp-server` plugin.

## Dependencies

```bash
bun add @modelcontextprotocol/sdk fastify-mcp-server
```

**Package versions:**

- `@modelcontextprotocol/sdk` - MCP SDK for server creation
- `fastify-mcp-server` - Official Fastify plugin

## Basic Setup

### 1. Create MCP Server

```typescript
// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export function createMCPServer(services: AppServices) {
  const server = new McpServer(
    {
      name: 'my-api-server',
      version: '1.0.0',
    },
    {
      instructions: `
# My API Server

This MCP server provides tools for interacting with the API.

## Available Tools
- list_items: List all items
- get_item: Get a specific item by ID
- create_item: Create a new item
      `
    }
  )

  // Register tools (see Tool Definitions section)
  registerTools(server, services)

  return server
}
```

### 2. Register MCP Plugin

```typescript
// src/mcp/index.ts
import { FastifyInstance } from 'fastify'
import FastifyMcpServer, { getMcpDecorator } from 'fastify-mcp-server'
import { createMCPServer } from './server.js'
import { TokenVerifier } from './auth-verifier.js'

export async function registerMCPPlugin(fastify: FastifyInstance) {
  const mcpServer = createMCPServer({
    itemService: fastify.itemService,
    userService: fastify.userService,
  })

  // Create token verifier for authentication
  const tokenVerifier = new TokenVerifier(fastify)

  // Register the MCP plugin
  await fastify.register(FastifyMcpServer, {
    server: mcpServer.server,
    endpoint: '/mcp',  // MCP endpoint (NOT under /api prefix)
    bearerMiddlewareOptions: {
      verifier: tokenVerifier,
    },
  })

  // Set up session management
  setupSessionManagement(fastify)
}

function setupSessionManagement(fastify: FastifyInstance) {
  const mcpDecorator = getMcpDecorator(fastify)
  const sessionManager = mcpDecorator.getSessionManager()

  sessionManager.on('sessionCreated', (sessionId: string) => {
    fastify.log.info(`MCP session created: ${sessionId}`)
  })

  sessionManager.on('sessionDestroyed', (sessionId: string) => {
    fastify.log.info(`MCP session destroyed: ${sessionId}`)
    // Clean up any session-specific state
  })

  sessionManager.on('transportError', (sessionId: string, error: Error) => {
    fastify.log.error({ err: error, sessionId }, 'MCP transport error')
  })

  // Graceful shutdown
  fastify.addHook('onClose', async () => {
    fastify.log.info('Shutting down MCP sessions...')
    await mcpDecorator.shutdown()
  })
}
```

### 3. Register in app.ts

```typescript
// src/app.ts
import { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { registerMCPPlugin } from './mcp/index.js'

export const app: FastifyPluginAsync = async (fastify, opts) => {
  // Register environment config first
  await fastify.register(envPlugin)

  // Initialize services
  // ...

  // Register CORS with MCP headers
  await fastify.register(import('@fastify/cors'), {
    origin: fastify.config.NODE_ENV === 'production' ? false : true,
    credentials: true,
    exposedHeaders: ['Mcp-Session-Id', 'X-Request-Id'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'X-Request-Id']
  })

  // Register API routes
  await fastify.register(healthRoutes, { prefix: '/api/health' })
  await fastify.register(itemRoutes, { prefix: '/api/items' })

  // Register MCP plugin AFTER API routes
  await fastify.register(registerMCPPlugin)
}

export default fp(app, '5.x')
```

## Authentication

### Token Verifier Interface

```typescript
// src/mcp/auth-verifier.ts
import { FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'

export interface OAuthTokenVerifier {
  verifyAccessToken(token: string): Promise<AuthInfo>
}

export interface AuthInfo {
  token: string
  clientId: string
  scopes: string[]
  expiresAt?: number
  extra?: Record<string, unknown>
}
```

### JWT Token Verifier Implementation

```typescript
export class TokenVerifier implements OAuthTokenVerifier {
  constructor(private fastify: FastifyInstance) {}

  private mapGroupsToScopes(groups: string[]): string[] {
    const scopes = new Set<string>()

    // All authenticated users get read access
    scopes.add('api:read')

    // Admins get all scopes
    if (groups.includes('admin')) {
      scopes.add('api:write')
      scopes.add('api:admin')
    }

    // Developers get write access
    if (groups.includes('developers')) {
      scopes.add('api:write')
    }

    return Array.from(scopes)
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const config = this.fastify.config
      const decoded = jwt.verify(token, config.JWT_SECRET, {
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE
      }) as { sub: string; email: string; groups: string[]; exp: number }

      const scopes = this.mapGroupsToScopes(decoded.groups || [])

      return {
        token,
        clientId: decoded.email,
        scopes,
        expiresAt: decoded.exp,
        extra: {
          email: decoded.email,
          groups: decoded.groups,
        },
      }
    } catch (error) {
      throw new Error('Token verification failed')
    }
  }
}
```

### Scope Mapping

| User Group | Granted Scopes |
|------------|----------------|
| All authenticated | `api:read` |
| `developers` | `api:read`, `api:write` |
| `admin` | `api:read`, `api:write`, `api:admin` |

## Tool Definitions

### Basic Tool Pattern

```typescript
// src/mcp/server.ts
import { z } from 'zod'

function registerTools(server: McpServer, services: AppServices) {
  // Read operation
  server.registerTool(
    'list_items',
    {
      description: 'List all items with optional filtering',
      inputSchema: {
        category: z.string().optional().describe('Filter by category'),
        limit: z.number().optional().describe('Maximum items to return')
      }
    },
    async ({ category, limit }, { authInfo, sessionId }) => {
      try {
        const items = await services.itemService.findAll({
          category,
          limit: limit || 100
        })

        return {
          content: [{
            type: 'text',
            text: items.map(item => `${item.id}: ${item.name}`).join('\n')
          }]
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        }
      }
    }
  )
}
```

### Tool with Authentication Context

```typescript
server.registerTool(
  'create_item',
  {
    description: 'Create a new item (requires write access)',
    inputSchema: {
      name: z.string().describe('Item name'),
      content: z.string().describe('Item content'),
      category: z.string().optional().describe('Item category')
    }
  },
  async ({ name, content, category }, { authInfo, sessionId }) => {
    // Check scopes
    if (!authInfo?.scopes.includes('api:write')) {
      return {
        content: [{
          type: 'text',
          text: 'Error: Write access required. Please authenticate with appropriate permissions.'
        }],
        isError: true
      }
    }

    try {
      // Forward auth token to downstream services if needed
      const headers: Record<string, string> = {}
      if (authInfo?.token) {
        headers['Authorization'] = `Bearer ${authInfo.token}`
      }

      const item = await services.itemService.create(
        { name, content, category },
        { headers }
      )

      return {
        content: [{
          type: 'text',
          text: `Created item: ${item.id} (${item.name})`
        }]
      }
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error creating item: ${error instanceof Error ? error.message : 'Unknown error'}`
        }],
        isError: true
      }
    }
  }
)
```

### Tool Response Formats

```typescript
// Text response
return {
  content: [{
    type: 'text',
    text: 'Operation completed successfully'
  }]
}

// Error response
return {
  content: [{
    type: 'text',
    text: 'Error: Something went wrong'
  }],
  isError: true
}

// Multiple content items
return {
  content: [
    { type: 'text', text: '# Results\n\n' },
    { type: 'text', text: formattedData }
  ]
}
```

## Session State Management

Track state across multiple tool calls within a session:

```typescript
// src/mcp/index.ts
type SessionState = Map<string, SessionData>

interface SessionData {
  branch?: string
  preferences?: Record<string, unknown>
  lastActivity: Date
}

const sessionState: SessionState = new Map()

export async function registerMCPPlugin(fastify: FastifyInstance) {
  // Pass session state to server creation
  const mcpServer = createMCPServer(services, sessionState)

  // ... register plugin ...

  // Clean up on session destroy
  const mcpDecorator = getMcpDecorator(fastify)
  const sessionManager = mcpDecorator.getSessionManager()

  sessionManager.on('sessionDestroyed', (sessionId: string) => {
    sessionState.delete(sessionId)
    fastify.log.info(`Cleaned up state for session: ${sessionId}`)
  })
}
```

### Using Session State in Tools

```typescript
server.registerTool(
  'set_preference',
  {
    description: 'Set a preference for this session',
    inputSchema: {
      key: z.string().describe('Preference key'),
      value: z.string().describe('Preference value')
    }
  },
  async ({ key, value }, { sessionId }) => {
    const state = sessionState.get(sessionId || 'default') || {
      lastActivity: new Date()
    }

    state.preferences = state.preferences || {}
    state.preferences[key] = value
    state.lastActivity = new Date()

    sessionState.set(sessionId || 'default', state)

    return {
      content: [{
        type: 'text',
        text: `Preference '${key}' set to '${value}'`
      }]
    }
  }
)
```

## CORS Configuration

MCP requires specific headers to be exposed:

```typescript
await fastify.register(import('@fastify/cors'), {
  origin: fastify.config.NODE_ENV === 'production'
    ? fastify.config.ALLOWED_ORIGINS?.split(',')
    : true,
  credentials: true,
  // MCP-specific headers
  exposedHeaders: ['Mcp-Session-Id', 'X-Request-Id'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'X-Request-Id']
})
```

## Environment Configuration

Add MCP-related config to your env plugin:

```typescript
// src/plugins/env.ts
const schema = {
  type: 'object',
  required: ['JWT_SECRET'],
  properties: {
    // ... existing config ...

    // MCP-specific (optional)
    MCP_MAX_SESSIONS: {
      type: 'number',
      default: 100,
      description: 'Maximum concurrent MCP sessions'
    },
    MCP_SESSION_TIMEOUT: {
      type: 'number',
      default: 3600000,  // 1 hour in ms
      description: 'Session timeout in milliseconds'
    }
  }
}
```

## Testing MCP Endpoints

### Using curl

```bash
# Initialize session
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "test-client", "version": "1.0.0" }
    }
  }'

# Call a tool
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "list_items",
      "arguments": { "limit": 10 }
    }
  }'
```

### Session Header Flow

1. Client sends request without `Mcp-Session-Id`
2. Server creates session and returns `Mcp-Session-Id` in response headers
3. Client includes `Mcp-Session-Id` in subsequent requests
4. Server maintains state for that session

## Project Structure

```
backend/
├── src/
│   ├── mcp/
│   │   ├── index.ts           # Plugin registration, session management
│   │   ├── server.ts          # MCP server creation, tool definitions
│   │   └── auth-verifier.ts   # Token verification
│   ├── plugins/
│   │   └── env.ts
│   ├── routes/
│   ├── services/
│   ├── app.ts                 # Main app with MCP registration
│   └── index.ts
└── package.json
```

## Common Patterns

### Error Handling in Tools

```typescript
async (inputs, context) => {
  try {
    const result = await performOperation(inputs)
    return formatSuccessResponse(result)
  } catch (error) {
    if (error instanceof ValidationError) {
      return {
        content: [{ type: 'text', text: `Validation error: ${error.message}` }],
        isError: true
      }
    }
    if (error instanceof NotFoundError) {
      return {
        content: [{ type: 'text', text: `Not found: ${error.message}` }],
        isError: true
      }
    }
    // Log unexpected errors
    context.logger?.error(error, 'Unexpected error in tool')
    return {
      content: [{ type: 'text', text: 'An unexpected error occurred' }],
      isError: true
    }
  }
}
```

### Forwarding Auth to Downstream Services

```typescript
async ({ id }, { authInfo, sessionId }) => {
  const headers: Record<string, string> = {}

  // Forward bearer token
  if (authInfo?.token) {
    headers['Authorization'] = `Bearer ${authInfo.token}`
  }

  // Forward session context
  if (sessionId) {
    headers['X-Session-Id'] = sessionId
  }

  const result = await downstreamService.fetch(id, { headers })
  return formatResponse(result)
}
```

### Scope-Based Access Control

```typescript
function requireScope(scope: string) {
  return (authInfo: AuthInfo | undefined): boolean => {
    if (!authInfo) return false
    return authInfo.scopes.includes(scope)
  }
}

// In tool
if (!requireScope('api:write')(authInfo)) {
  return {
    content: [{ type: 'text', text: 'Write access required' }],
    isError: true
  }
}
```
