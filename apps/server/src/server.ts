import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import postgres from 'postgres';
import { createScheduler } from '@jarvus/claude-assist-core';
import sessionsPlugin from '@jarvus/claude-assist-sessions';
import googlePlugin from '@jarvus/claude-assist-google';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import envPlugin from './plugins/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Create Fastify instance
// Note: LOG_LEVEL and NODE_ENV read from process.env here since env plugin isn't loaded yet
const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport:
      process.env.NODE_ENV === 'development'
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

// Register env plugin FIRST to validate and load configuration
await fastify.register(envPlugin);

// Create postgres connection using validated config
const sql = postgres(fastify.config.DATABASE_URL);

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
    if (fastify.config.ENABLE_SESSIONS !== 'false') {
      api.log.info('Sessions module enabled');
      await api.register(sessionsPlugin, {
        migrationsDir: join(__dirname, '../../../packages/sessions/migrations'),
        disableMigrations: fastify.config.DISABLE_MIGRATIONS === 'true',
        sessionsConfig: {
          originalClaudeDir: fastify.config.SESSIONS_ORIGINAL_CLAUDE_DIR,
          minFileSize: fastify.config.SESSIONS_MIN_FILE_SIZE,
          anthropicApiKey: fastify.config.ANTHROPIC_API_KEY,
          outlineConcurrency: fastify.config.OUTLINE_CONCURRENCY,
          disableLocalIngest:
            fastify.config.SESSIONS_DISABLE_LOCAL_INGEST === 'true',
          disableGenerateOutlines:
            fastify.config.SESSIONS_DISABLE_GENERATE_OUTLINES === 'true',
        },
      });
    } else {
      api.log.info('Sessions module disabled');
    }

    if (fastify.config.ENABLE_GOOGLE !== 'false') {
      if (
        !fastify.config.GOOGLE_CLIENT_ID ||
        !fastify.config.GOOGLE_CLIENT_SECRET
      ) {
        api.log.warn(
          'Google module enabled but GOOGLE_CLIENT_ID/SECRET not set - skipping'
        );
      } else {
        api.log.info('Google module enabled');
        await api.register(googlePlugin, {
          migrationsDir: join(__dirname, '../../../packages/google/migrations'),
          disableMigrations: fastify.config.DISABLE_MIGRATIONS === 'true',
          googleConfig: {
            clientId: fastify.config.GOOGLE_CLIENT_ID,
            clientSecret: fastify.config.GOOGLE_CLIENT_SECRET,
            redirectUri: fastify.config.GOOGLE_REDIRECT_URI,
            anthropicApiKey: fastify.config.ANTHROPIC_API_KEY,
            triageConcurrency: fastify.config.TRIAGE_CONCURRENCY,
            disableEmailSync:
              fastify.config.GOOGLE_DISABLE_EMAIL_SYNC === 'true',
            disableEmailTriage:
              fastify.config.GOOGLE_DISABLE_EMAIL_TRIAGE === 'true',
          },
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
    await fastify.listen({
      port: fastify.config.PORT,
      host: fastify.config.HOST,
    });
    fastify.log.info(
      `Server listening on http://${fastify.config.HOST}:${fastify.config.PORT}`
    );
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
