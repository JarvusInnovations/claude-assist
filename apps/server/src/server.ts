import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import postgres from 'postgres';
import { createScheduler } from '@jarvus/claude-assist-core';
import sessionsPlugin, {
  registerPublicShareRoutes,
  DEFAULT_SESSION_IGNORE_MARKERS,
} from '@jarvus/claude-assist-sessions';
import googlePlugin from '@jarvus/claude-assist-google';
import capturePlugin from '@jarvus/claude-assist-capture';
import chatPlugin from '@jarvus/claude-assist-chat';
import notifyPlugin from '@jarvus/claude-assist-notify';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import envPlugin from './plugins/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Create Fastify instance
// Note: LOG_LEVEL read from process.env here since env plugin isn't loaded yet.
// Pretty-print only for an interactive terminal (or an explicit opt-in via
// LOG_PRETTY=1) - NODE_ENV=development is set in the live .env regardless of
// how the process is run, so gating on it made pino-pretty (with ANSI color
// codes) always fire, including under systemd where stdout goes straight to
// journald. Raw ndjson is what journald/`journalctl -o cat` expect.
const usePrettyLogs = Boolean(process.stdout.isTTY) || process.env.LOG_PRETTY === '1';
const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: usePrettyLogs
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

    // Notify module — registered FIRST so its fastify.notify / fastify.heartbeats
    // decorators are available to the sessions + google pipelines below.
    if (fastify.config.ENABLE_NOTIFY) {
      api.log.info('Notify module enabled');
      await api.register(notifyPlugin, {
        migrationsDir: join(__dirname, '../../../packages/notify/migrations'),
        disableMigrations: fastify.config.DISABLE_MIGRATIONS,
        notifyConfig: {
          pushoverToken: fastify.config.PUSHOVER_TOKEN,
          pushoverUser: fastify.config.PUSHOVER_USER,
          slackBotToken: fastify.config.SLACK_BOT_TOKEN,
          slackOwnerUserId: fastify.config.SLACK_OWNER_USER_ID,
          hariRepoPath:
            fastify.config.NOTIFY_HARI_REPO_PATH ?? fastify.config.AGENT_REPO_PATH,
          diskCheckPath: fastify.config.NOTIFY_DISK_PATH,
          diskMinFreeBytes: fastify.config.NOTIFY_DISK_MIN_FREE_GB * 1024 ** 3,
          diskMinFreePct: fastify.config.NOTIFY_DISK_MIN_FREE_PCT / 100,
          stalenessCron: fastify.config.NOTIFY_STALENESS_CRON,
          digestFlushCron: fastify.config.NOTIFY_DIGEST_FLUSH_CRON,
          disableStalenessCheck: fastify.config.NOTIFY_DISABLE_STALENESS,
        },
      });
    } else {
      api.log.info('Notify module disabled');
    }

    // Register plugins conditionally based on environment
    if (fastify.config.ENABLE_SESSIONS) {
      api.log.info('Sessions module enabled');
      await api.register(sessionsPlugin, {
        migrationsDir: join(__dirname, '../../../packages/sessions/migrations'),
        disableMigrations: fastify.config.DISABLE_MIGRATIONS,
        sessionsConfig: {
          originalClaudeDir: fastify.config.SESSIONS_ORIGINAL_CLAUDE_DIR,
          minFileSize: fastify.config.SESSIONS_MIN_FILE_SIZE,
          anthropicApiKey: fastify.config.ANTHROPIC_API_KEY,
          outlineConcurrency: fastify.config.OUTLINE_CONCURRENCY,
          disableLocalIngest:
            fastify.config.DISABLE_SYNCS ||
            fastify.config.SESSIONS_DISABLE_LOCAL_INGEST,
          disableGenerateOutlines:
            fastify.config.DISABLE_SYNCS ||
            fastify.config.SESSIONS_DISABLE_GENERATE_OUTLINES,
          disableClassification:
            fastify.config.DISABLE_SYNCS ||
            fastify.config.SESSIONS_DISABLE_CLASSIFICATION,
          classificationConcurrency: fastify.config.SESSIONS_CLASSIFICATION_CONCURRENCY,
          classificationMinDelta: fastify.config.SESSIONS_CLASSIFICATION_MIN_DELTA,
          classificationLookback: fastify.config.SESSIONS_CLASSIFICATION_LOOKBACK,
          classificationCron: fastify.config.SESSIONS_CLASSIFICATION_CRON,
          synthesisCron: fastify.config.SESSIONS_SYNTHESIS_CRON,
          synthesisModel: fastify.config.SESSIONS_SYNTHESIS_MODEL,
          ignoreContentMarkers: [
            ...DEFAULT_SESSION_IGNORE_MARKERS,
            ...(fastify.config.SESSIONS_IGNORE_MARKERS
              ? fastify.config.SESSIONS_IGNORE_MARKERS.split('\n')
                  .map((m) => m.trim())
                  .filter(Boolean)
              : []),
          ],
        },
      });
    } else {
      api.log.info('Sessions module disabled');
    }

    if (fastify.config.ENABLE_GOOGLE) {
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
          disableMigrations: fastify.config.DISABLE_MIGRATIONS,
          googleConfig: {
            clientId: fastify.config.GOOGLE_CLIENT_ID,
            clientSecret: fastify.config.GOOGLE_CLIENT_SECRET,
            redirectUri: fastify.config.GOOGLE_REDIRECT_URI,
            anthropicApiKey: fastify.config.ANTHROPIC_API_KEY,
            triageConcurrency: fastify.config.TRIAGE_CONCURRENCY,
            disableEmailSync:
              fastify.config.DISABLE_SYNCS ||
              fastify.config.GOOGLE_DISABLE_EMAIL_SYNC,
            disableEmailTriage:
              fastify.config.DISABLE_SYNCS ||
              fastify.config.GOOGLE_DISABLE_EMAIL_TRIAGE,
            disableEmailActions:
              fastify.config.DISABLE_SYNCS ||
              fastify.config.GOOGLE_DISABLE_EMAIL_ACTIONS,
            disableEmailAlerts: fastify.config.GOOGLE_DISABLE_EMAIL_ALERTS,
            teamDomains: fastify.config.GOOGLE_TEAM_DOMAINS.split(',')
              .map((d) => d.trim())
              .filter(Boolean),
            triageSeedFile: fastify.config.GOOGLE_TRIAGE_SEED_FILE,
            emailDigestCron: fastify.config.GOOGLE_EMAIL_DIGEST_CRON,
            spamQuarantineDigestCron: fastify.config.GOOGLE_SPAM_QUARANTINE_CRON,
          },
        });
      }
    } else {
      api.log.info('Google module disabled');
    }

    if (fastify.config.ENABLE_CAPTURE) {
      api.log.info('Capture module enabled');
      await api.register(capturePlugin, {
        migrationsDir: join(__dirname, '../../../packages/capture/migrations'),
        disableMigrations: fastify.config.DISABLE_MIGRATIONS,
        captureConfig: {
          anthropicApiKey: fastify.config.ANTHROPIC_API_KEY,
          classifierModel: fastify.config.CAPTURE_CLASSIFIER_MODEL,
          concurrency: fastify.config.CAPTURE_CONCURRENCY,
          disableClassification:
            fastify.config.DISABLE_SYNCS ||
            fastify.config.CAPTURE_DISABLE_CLASSIFICATION,
          tanaMcpUrl: fastify.config.TANA_MCP_URL,
          tanaMcpToken: fastify.config.TANA_MCP_TOKEN,
          tanaWorkspaceId: fastify.config.TANA_WORKSPACE_ID,
        },
      });
    } else {
      api.log.info('Capture module disabled');
    }

    // Chat module is registered outside /api prefix (uses Socket Mode, not webhooks)
  },
  { prefix: '/api' }
);

// Chat module (Socket Mode — manages its own WebSocket connection)
if (fastify.config.ENABLE_CHAT) {
  if (
    !fastify.config.SLACK_BOT_TOKEN ||
    !fastify.config.SLACK_APP_TOKEN ||
    !fastify.config.SLACK_SIGNING_SECRET ||
    !fastify.config.SLACK_OWNER_USER_ID ||
    !fastify.config.AGENT_REPO_PATH
  ) {
    fastify.log.warn(
      'Chat module enabled but missing required config (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, SLACK_OWNER_USER_ID, AGENT_REPO_PATH) - skipping'
    );
  } else {
    fastify.log.info('Chat module enabled');
    await fastify.register(chatPlugin, {
      migrationsDir: join(__dirname, '../../../packages/chat/migrations'),
      disableMigrations: fastify.config.DISABLE_MIGRATIONS,
      chatConfig: {
        slackBotToken: fastify.config.SLACK_BOT_TOKEN,
        slackAppToken: fastify.config.SLACK_APP_TOKEN,
        slackSigningSecret: fastify.config.SLACK_SIGNING_SECRET,
        ownerSlackUserId: fastify.config.SLACK_OWNER_USER_ID,
        agentRepoPath: fastify.config.AGENT_REPO_PATH!,
        botUsername: fastify.config.BOT_USERNAME,
        claudeOauthToken: fastify.config.CLAUDE_CODE_OAUTH_TOKEN,
      },
    });
  }
} else {
  fastify.log.info('Chat module disabled');
}

// Public share routes — bypass Caddy basic-auth via /share/* path pattern
await fastify.register(registerPublicShareRoutes);

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
  await fastify.close(); // stops Bolt (via onClose hook) before closing DB
  await sql.end();
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
