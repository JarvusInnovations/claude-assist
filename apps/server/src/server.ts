import Fastify from 'fastify';
import postgres from 'postgres';
import { createScheduler } from '@jarvus/claude-assist-core';
import sessionsPlugin from '@jarvus/claude-assist-sessions';
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
  bodyLimit: 200 * 1024 * 1024,
});

// Create postgres connection
const sql = postgres(env.DATABASE_URL);

// Decorate Fastify instance
fastify.decorate('sql', sql);
fastify.decorate('scheduler', createScheduler(fastify));

// Register plugins
await fastify.register(sessionsPlugin, {
  migrationsDir: join(__dirname, '../../../packages/sessions/migrations'),
});

// Health check endpoint
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Scheduler endpoints
fastify.get('/scheduler/tasks', async () => {
  return fastify.scheduler.list();
});

fastify.post<{ Params: { name: string } }>(
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
