import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import postgres from 'postgres';
import { createScheduler } from '@jarvus/claude-assist-core';
import sessionsPlugin from '@jarvus/claude-assist-sessions';
import googlePlugin from '@jarvus/claude-assist-google';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Create Fastify instance
const fastify = Fastify({
  logger: {
    level: env.LOG_LEVEL,
    transport:
      env.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
  },
  // Allow large payloads for session transcript uploads (200MB)
  bodyLimit: 500 * 1024 * 1024,
});

// Create postgres connection
const sql = postgres(env.DATABASE_URL);

// Decorate Fastify instance
fastify.decorate('sql', sql);
fastify.decorate('scheduler', createScheduler(fastify));

// Register all API routes under /api prefix
await fastify.register(
  async (api) => {
    // Health check endpoint
    api.get('/health', async () => {
      return { status: 'ok', timestamp: new Date().toISOString() };
    });

    // Scheduler endpoints
    api.get('/scheduler/tasks', async () => {
      return fastify.scheduler.list();
    });

    api.post<{ Params: { name: string } }>(
      '/scheduler/tasks/:name',
      async (request, reply) => {
        try {
          await fastify.scheduler.trigger(request.params.name);
          return { status: 'triggered', task: request.params.name };
        } catch (error) {
          reply.status(404);
          return { error: (error as Error).message };
        }
      }
    );

    // Register plugins conditionally based on environment
    if (env.ENABLE_SESSIONS !== 'false') {
      api.log.info('Sessions module enabled');
      await api.register(sessionsPlugin, {
        migrationsDir: join(__dirname, '../../../packages/sessions/migrations'),
      });
    } else {
      api.log.info('Sessions module disabled');
    }

    if (env.ENABLE_GOOGLE !== 'false') {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        api.log.warn(
          'Google module enabled but GOOGLE_CLIENT_ID/SECRET not set - skipping'
        );
      } else {
        api.log.info('Google module enabled');
        await api.register(googlePlugin, {
          migrationsDir: join(__dirname, '../../../packages/google/migrations'),
        });
      }
    } else {
      api.log.info('Google module disabled');
    }
  },
  { prefix: '/api' }
);

// Serve admin frontend static files
await fastify.register(fastifyStatic, {
  root: join(__dirname, '../../admin/dist'),
  prefix: '/',
});

// SPA fallback - serve index.html for non-API routes
fastify.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api')) {
    return reply.status(404).send({ error: 'Not found' });
  }
  return reply.sendFile('index.html');
});

// Graceful shutdown
const shutdown = async () => {
  fastify.log.info('Shutting down...');
  fastify.scheduler.stop();
  await sql.end();
  await fastify.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: env.PORT, host: env.HOST });
    fastify.log.info(`Server listening on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
