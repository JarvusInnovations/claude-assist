# API Design

Patterns for designing consistent, well-documented APIs with Fastify.

## Response Format

Pick **one** response convention and apply it consistently across the API. The
`{success, data, error}` envelope below is one solid option — not a requirement.
Structured domain-specific bodies are equally valid and often spec-mandated: returning
the resource directly on success, and on error a body whose `error` field is a
**machine-branchable discriminator** with domain fields alongside, e.g.

```typescript
// 403 - the client can branch on error and render a specific message
{ error: 'forbidden', required: 'operator', environment: 'production', your_role: 'viewer' }

// 409 - a domain conflict carrying its own contract
{ error: 'env_promote_only', environment: 'production', promotes_from: 'staging' }
```

If a spec defines error contracts like these, follow the spec — don't wrap them in an
envelope. What matters is consistency and that error bodies are branchable, not the
particular wrapper.

### The Envelope Option

```typescript
// Success response
{
  success: true,
  data: T,
  metadata?: {
    timestamp: string,
    count?: number,
    page?: number,
    totalPages?: number
  }
}

// Error response
{
  success: false,
  error: string,
  details?: Record<string, string[]>  // Field-level validation errors
}
```

### Implementation

```typescript
// Helper types
interface SuccessResponse<T> {
  success: true
  data: T
  metadata?: ResponseMetadata
}

interface ErrorResponse {
  success: false
  error: string
  details?: Record<string, string[]>
}

interface ResponseMetadata {
  timestamp: string
  count?: number
  page?: number
  totalPages?: number
}

type ApiResponse<T> = SuccessResponse<T> | ErrorResponse

// Helper functions
function successResponse<T>(data: T, metadata?: Partial<ResponseMetadata>): SuccessResponse<T> {
  return {
    success: true,
    data,
    metadata: metadata ? { timestamp: new Date().toISOString(), ...metadata } : undefined
  }
}

function errorResponse(error: string, details?: Record<string, string[]>): ErrorResponse {
  return {
    success: false,
    error,
    details
  }
}
```

### Usage in Routes

```typescript
fastify.get('/users', async (request, reply) => {
  const users = await fastify.userService.findAll()
  return successResponse(users, { count: users.length })
})

fastify.get<{ Params: { id: string } }>('/users/:id', async (request, reply) => {
  const { id } = request.params
  const user = await fastify.userService.findById(id)

  if (!user) {
    reply.code(404)
    return errorResponse('User not found')
  }

  return successResponse(user)
})
```

## Error Handling

### Typed Error Responses

```typescript
fastify.post('/users', async (request, reply) => {
  try {
    const user = await fastify.userService.create(request.body)
    reply.code(201)
    return successResponse(user)
  } catch (error) {
    if (error instanceof ValidationError) {
      reply.code(400)
      return errorResponse('Validation failed', error.fields)
    }

    if (error instanceof DuplicateError) {
      reply.code(409)
      return errorResponse('User already exists')
    }

    // Log unexpected errors
    request.log.error(error, 'Failed to create user')
    reply.code(500)
    return errorResponse('Internal server error')
  }
})
```

### HTTP Status Codes

| Code | Usage |
| ------ | ------- |
| 200 | Successful GET, PUT, PATCH |
| 201 | Successful POST (resource created) |
| 204 | Successful DELETE (no content) |
| 400 | Bad request / validation error |
| 401 | Authentication required |
| 403 | Insufficient permissions |
| 404 | Resource not found |
| 409 | Conflict (duplicate resource) |
| 500 | Internal server error |

## Swagger/OpenAPI Integration

### Installation

```bash
bun add @fastify/swagger @fastify/swagger-ui
```

### Configuration in app.ts

```typescript
import { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

export const app: FastifyPluginAsync = async (fastify, opts) => {
  await fastify.register(envPlugin)

  // Register Swagger
  await fastify.register(import('@fastify/swagger'), {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'My API',
        description: 'API documentation',
        version: '1.0.0'
      },
      servers: [{
        url: `http://${fastify.config.HOST}:${fastify.config.PORT}`,
        description: 'Development server'
      }],
      tags: [
        { name: 'users', description: 'User management' },
        { name: 'orders', description: 'Order management' },
        { name: 'health', description: 'Health checks' }
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
          }
        }
      }
    }
  })

  // Register Swagger UI
  await fastify.register(import('@fastify/swagger-ui'), {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true
    }
  })

  // Register routes after swagger
  await fastify.register(userRoutes, { prefix: '/api/users' })
}
```

### Route Schema with Swagger Metadata

```typescript
fastify.get('/users', {
  schema: {
    description: 'List all users',
    tags: ['users'],
    security: [{ bearerAuth: [] }],
    querystring: {
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1, default: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      }
    },
    response: {
      200: {
        description: 'Successful response',
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                email: { type: 'string' },
                createdAt: { type: 'string', format: 'date-time' }
              }
            }
          },
          metadata: {
            type: 'object',
            properties: {
              count: { type: 'integer' },
              page: { type: 'integer' },
              totalPages: { type: 'integer' }
            }
          }
        }
      }
    }
  }
}, async (request, reply) => {
  // Implementation
})
```

## CORS Configuration

### Environment-Based CORS

```typescript
// In app.ts
await fastify.register(import('@fastify/cors'), {
  origin: fastify.config.NODE_ENV === 'production'
    ? fastify.config.ALLOWED_ORIGINS?.split(',') || false
    : true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
})
```

### Environment Config for CORS

```typescript
// In env.ts schema
properties: {
  ALLOWED_ORIGINS: {
    type: 'string',
    description: 'Comma-separated list of allowed origins for CORS'
  }
}
```

## Pagination

### Query Parameters

```typescript
interface PaginationQuery {
  page?: number
  limit?: number
}

fastify.get<{ Querystring: PaginationQuery }>('/items', {
  schema: {
    querystring: {
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1, default: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      }
    }
  }
}, async (request, reply) => {
  const { page = 1, limit = 20 } = request.query
  const offset = (page - 1) * limit

  const { items, total } = await fastify.itemService.findPaginated(offset, limit)
  const totalPages = Math.ceil(total / limit)

  return successResponse(items, {
    count: items.length,
    page,
    totalPages
  })
})
```

## Query Building

### Dynamic WHERE Clauses

For services that build dynamic queries:

```typescript
interface QueryFilters {
  status?: string
  category?: string
  minPrice?: number
  maxPrice?: number
}

async findFiltered(filters: QueryFilters) {
  const whereClauses: string[] = []
  const params: Record<string, unknown> = {}

  if (filters.status) {
    whereClauses.push('status = @status')
    params.status = filters.status
  }

  if (filters.category) {
    whereClauses.push('category = @category')
    params.category = filters.category
  }

  if (filters.minPrice !== undefined) {
    whereClauses.push('price >= @minPrice')
    params.minPrice = filters.minPrice
  }

  if (filters.maxPrice !== undefined) {
    whereClauses.push('price <= @maxPrice')
    params.maxPrice = filters.maxPrice
  }

  const whereClause = whereClauses.length > 0
    ? `WHERE ${whereClauses.join(' AND ')}`
    : ''

  const query = `
    SELECT * FROM items
    ${whereClause}
    ORDER BY created_at DESC
  `

  return this.db.query(query, params)
}
```

## Validation Patterns

### Reusable Schema Definitions

```typescript
// src/schemas/common.ts
export const paginationSchema = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
}

export const successResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean', const: true },
    data: {},  // Override in specific routes
    metadata: {
      type: 'object',
      properties: {
        timestamp: { type: 'string' },
        count: { type: 'integer' }
      }
    }
  }
}

export const errorResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean', const: false },
    error: { type: 'string' },
    details: {
      type: 'object',
      additionalProperties: {
        type: 'array',
        items: { type: 'string' }
      }
    }
  }
}
```

### Using Shared Schemas

```typescript
import { paginationSchema, errorResponseSchema } from '../schemas/common'

fastify.get('/items', {
  schema: {
    querystring: paginationSchema,
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            type: 'array',
            items: { $ref: '#/components/schemas/Item' }
          }
        }
      },
      400: errorResponseSchema
    }
  }
})
```

## Health Check Endpoint

Standard health check for monitoring:

```typescript
// src/routes/health.ts
import { FastifyPluginAsync } from 'fastify'

const healthRoutes: FastifyPluginAsync = async (fastify, opts) => {
  fastify.get('/', {
    schema: {
      description: 'Health check endpoint',
      tags: ['health'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
            service: { type: 'string' },
            version: { type: 'string' },
            environment: { type: 'string' }
          }
        }
      }
    }
  }, async (request, reply) => {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'my-api',
      version: '1.0.0',
      environment: fastify.config.NODE_ENV
    }
  })
}

export default healthRoutes
```
