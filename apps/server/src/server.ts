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
import kitchenPlugin from '@jarvus/claude-assist-kitchen';
import slackUrgencyPlugin from '@jarvus/claude-assist-slack-urgency';
import briefingPlugin from '@jarvus/claude-assist-briefing';
import chatPlugin, { parseContextCommands } from '@jarvus/claude-assist-chat';
import notifyPlugin from '@jarvus/claude-assist-notify';
import sessionSpawnPlugin, { parseSpawnCommand } from '@jarvus/claude-assist-session-spawn';
import pagesPlugin, { registerPagesPublicRoutes } from '@jarvus/claude-assist-pages';
import ledgerPlugin from '@jarvus/claude-assist-ledger';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import envPlugin from './plugins/env.js';
import { resolveUnmatched } from './not-found.js';
import type { CoverageLedgerConfig } from '@jarvus/claude-assist-core';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse NOTIFY_COVERAGE_LEDGERS — a JSON array of
 * `{name, threshold, path}` — into ledger registrations. Malformed config is
 * logged and treated as empty rather than failing boot.
 */
function parseCoverageLedgers(
  raw: string | undefined,
  log: FastifyBaseLogger,
): CoverageLedgerConfig[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    return parsed.map((entry) => {
      const { name, threshold, path } = entry as Record<string, unknown>;
      if (typeof name !== 'string' || typeof threshold !== 'string' || typeof path !== 'string') {
        throw new Error('each ledger needs string name, threshold, and path');
      }
      return { name, threshold, path };
    });
  } catch (err) {
    log.error({ err }, 'NOTIFY_COVERAGE_LEDGERS is malformed — no coverage ledgers registered');
    return [];
  }
}

/**
 * Resolve the owner's agent-repo path for the notify module. Prefers
 * NOTIFY_AGENT_REPO_PATH, honors the deprecated NOTIFY_HARI_REPO_PATH alias
 * (with a startup warning) so existing deploys keep working, and finally falls
 * back to AGENT_REPO_PATH.
 */
function resolveAgentRepoPath(app: FastifyInstance): string | undefined {
  if (app.config.NOTIFY_AGENT_REPO_PATH) return app.config.NOTIFY_AGENT_REPO_PATH;
  if (app.config.NOTIFY_HARI_REPO_PATH) {
    app.log.warn(
      'NOTIFY_HARI_REPO_PATH is deprecated — rename it to NOTIFY_AGENT_REPO_PATH; the old name will be removed in a future release',
    );
    return app.config.NOTIFY_HARI_REPO_PATH;
  }
  return app.config.AGENT_REPO_PATH;
}

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

    // Ledger module — registered FIRST so its fastify.ledger decorator is
    // available to the notify dispatcher + google email executor below, both of
    // which write direct ledger rows at execution time.
    if (fastify.config.ENABLE_LEDGER) {
      api.log.info('Ledger module enabled');
      await api.register(ledgerPlugin, {
        migrationsDir: join(__dirname, '../../../packages/ledger/migrations'),
        disableMigrations: fastify.config.DISABLE_MIGRATIONS,
        ledgerConfig: {
          deriveCron: fastify.config.LEDGER_DERIVE_CRON,
          batchSize: fastify.config.LEDGER_DERIVE_BATCH_SIZE,
          disableDerivation:
            fastify.config.DISABLE_SYNCS || fastify.config.LEDGER_DISABLE_DERIVE,
        },
      });
    } else {
      api.log.info('Ledger module disabled');
    }

    // Notify module — registered before the sessions + google pipelines so its
    // fastify.notify / fastify.heartbeats decorators are available to them.
    if (fastify.config.ENABLE_NOTIFY) {
      api.log.info('Notify module enabled');
      await api.register(notifyPlugin, {
        migrationsDir: join(__dirname, '../../../packages/notify/migrations'),
        disableMigrations: fastify.config.DISABLE_MIGRATIONS,
        notifyConfig: {
          pushoverToken: fastify.config.PUSHOVER_TOKEN,
          pushoverUser: fastify.config.PUSHOVER_USER,
          agentRepoPath: resolveAgentRepoPath(fastify),
          coverageLedgers: parseCoverageLedgers(
            fastify.config.NOTIFY_COVERAGE_LEDGERS,
            fastify.log,
          ),
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

    // Session-spawn module — registered after notify (needs fastify.notify for
    // takeover-link dispatch) and BEFORE kitchen so its fastify.sessionSpawner
    // decorator is available to the kitchen plan-session route. Disabled (no
    // decorator) when SESSION_SPAWN_CMD is unset → the route 503s.
    if (fastify.config.ENABLE_SESSION_SPAWN) {
      api.log.info('Session-spawn module enabled');
      await api.register(sessionSpawnPlugin, {
        command: parseSpawnCommand(fastify.config.SESSION_SPAWN_CMD, fastify.log),
        timeoutMs: fastify.config.SESSION_SPAWN_TIMEOUT_MS,
        model: fastify.config.SESSION_SPAWN_MODEL,
      });
    } else {
      api.log.info('Session-spawn module disabled');
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
            urgencyTimeZone: fastify.config.GOOGLE_URGENCY_TZ,
            urgencyQuietStartHour: fastify.config.GOOGLE_URGENCY_QUIET_START,
            urgencyQuietEndHour: fastify.config.GOOGLE_URGENCY_QUIET_END,
            contactsFile: fastify.config.GOOGLE_CONTACTS_FILE,
            contactsBin: fastify.config.GOOGLE_CONTACTS_BIN,
            contactsArgs: fastify.config.GOOGLE_CONTACTS_ARGS.split(' ')
              .map((a) => a.trim())
              .filter(Boolean),
            opportunityPromptFile: fastify.config.GOOGLE_OPPORTUNITY_PROMPT_FILE,
            emailDigestCron: fastify.config.GOOGLE_EMAIL_DIGEST_CRON,
            spamQuarantineDigestCron: fastify.config.GOOGLE_SPAM_QUARANTINE_CRON,
            emailDigestPageUrl: fastify.config.GOOGLE_DIGEST_PAGE_URL,
          },
        });
      }
    } else {
      api.log.info('Google module disabled');
    }

    // Kitchen module — registered BEFORE capture so its fastify.kitchenEvents
    // resolver decorator is available to compose the capture module's
    // kitchen_event executor below (the two packages never import each other).
    if (fastify.config.ENABLE_KITCHEN) {
      api.log.info('Kitchen module enabled');
      await api.register(kitchenPlugin, {
        migrationsDir: join(__dirname, '../../../packages/kitchen/migrations'),
        disableMigrations: fastify.config.DISABLE_MIGRATIONS,
        kitchenConfig: {
          anthropicApiKey: fastify.config.ANTHROPIC_API_KEY,
          estimationModel: fastify.config.KITCHEN_ESTIMATION_MODEL,
          receiptModel: fastify.config.KITCHEN_RECEIPT_MODEL,
          planSessionModel: fastify.config.KITCHEN_PLAN_SESSION_MODEL,
          concurrency: fastify.config.KITCHEN_CONCURRENCY,
          disableEstimation:
            fastify.config.DISABLE_SYNCS || fastify.config.KITCHEN_DISABLE_ESTIMATION,
          maxPhotoBytes: fastify.config.KITCHEN_MAX_PHOTO_BYTES,
          maxPhotos: fastify.config.KITCHEN_MAX_PHOTOS,
          mealBankRepoPath: fastify.config.KITCHEN_MEALBANK_REPO_PATH,
          mealBankSheet: fastify.config.KITCHEN_MEALBANK_SHEET,
          tdeeBase: fastify.config.KITCHEN_TDEE_BASE,
          dailyTargets: fastify.config.KITCHEN_DAILY_TARGETS,
          ownerTz: fastify.config.KITCHEN_OWNER_TZ,
          stravaClientId: fastify.config.KITCHEN_STRAVA_CLIENT_ID,
          stravaClientSecret: fastify.config.KITCHEN_STRAVA_CLIENT_SECRET,
          stravaRefreshToken: fastify.config.KITCHEN_STRAVA_REFRESH_TOKEN,
          stravaSyncMinutes: fastify.config.KITCHEN_STRAVA_SYNC_MINUTES,
          disableStravaSync: fastify.config.DISABLE_SYNCS,
        },
      });
    } else {
      api.log.info('Kitchen module disabled');
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
          attachmentsBucket: fastify.config.CAPTURE_ATTACHMENTS_BUCKET,
          // Ambient kitchen-remark seam: the resolver decorated by the kitchen
          // module (registered above). Absent → kitchen_event captures park.
          kitchenEventResolver: api.kitchenEvents
            ? (remark: string) =>
                api.kitchenEvents!.resolve(remark).then((r) => ({
                  matched: r.matched,
                  itemUlid: r.item?.ulid,
                  eventType: r.event?.type,
                }))
            : undefined,
        },
      });
    } else {
      api.log.info('Capture module disabled');
    }

    // Pages module — publish + collect interactive HTML pages. Registered
    // after notify (needs fastify.notify for the response-notify dispatch).
    // Only the /api/pages/* API surface is under this prefix; the public
    // serving routes (GET /pages, GET /pages/:slug, GET /pages/_helper.js)
    // are registered separately below, outside /api.
    if (fastify.config.ENABLE_PAGES) {
      api.log.info('Pages module enabled');
      await api.register(pagesPlugin, {
        migrationsDir: join(__dirname, '../../../packages/pages/migrations'),
        disableMigrations: fastify.config.DISABLE_MIGRATIONS,
        pagesConfig: {
          baseUrl: fastify.config.PAGES_BASE_URL,
          // Worksheet cook-mode seam: the sink decorated by the kitchen module
          // (registered above). Absent → a cook-mode worksheet submission
          // reports `unavailable` instead of pretending it was logged.
          worksheetCookSink: api.kitchenCookMode,
        },
      });
    } else {
      api.log.info('Pages module disabled');
    }

    // Slack urgency module — read-only listener over the owner's Slack; interrupts
    // (via the notify dispatcher, registered above) only for what can't wait.
    // Reads AS the owner via a user token, so it's independent of the chat bot.
    if (fastify.config.ENABLE_SLACK_URGENCY) {
      if (
        !fastify.config.SLACK_URGENCY_USER_TOKEN ||
        !fastify.config.SLACK_OWNER_USER_ID
      ) {
        api.log.warn(
          'Slack urgency enabled but SLACK_URGENCY_USER_TOKEN / SLACK_OWNER_USER_ID not set - skipping'
        );
      } else {
        api.log.info('Slack urgency module enabled');
        await api.register(slackUrgencyPlugin, {
          schema: 'slack_urgency',
          migrationsDir: join(__dirname, '../../../packages/slack-urgency/migrations'),
          disableMigrations: fastify.config.DISABLE_MIGRATIONS,
          slackUrgencyConfig: {
            userToken: fastify.config.SLACK_URGENCY_USER_TOKEN,
            ownerId: fastify.config.SLACK_OWNER_USER_ID,
            roster: fastify.config.SLACK_URGENCY_ROSTER,
            watchChannels: fastify.config.SLACK_URGENCY_WATCH_CHANNELS
              ? fastify.config.SLACK_URGENCY_WATCH_CHANNELS.split(',')
                  .map((c) => c.trim())
                  .filter(Boolean)
              : [],
            anthropicApiKey: fastify.config.ANTHROPIC_API_KEY,
            model: fastify.config.SLACK_URGENCY_MODEL,
            timeZone: fastify.config.SLACK_URGENCY_TZ,
            quietStartHour: fastify.config.SLACK_URGENCY_QUIET_START,
            quietEndHour: fastify.config.SLACK_URGENCY_QUIET_END,
            cooldownMinutes: fastify.config.SLACK_URGENCY_COOLDOWN_MIN,
            historyLimit: fastify.config.SLACK_URGENCY_HISTORY_LIMIT,
            pollCron: fastify.config.SLACK_URGENCY_POLL_CRON,
            cycleIntervalMs: fastify.config.SLACK_URGENCY_POLL_INTERVAL_MS,
            disablePolling:
              fastify.config.DISABLE_SYNCS || fastify.config.SLACK_URGENCY_DISABLE_POLL,
          },
        });
      }
    } else {
      api.log.info('Slack urgency module disabled');
    }

    // Briefing module — daily briefing into Tana + join-required meeting alerts.
    // Registered after notify (needs fastify.notify / fastify.heartbeats) and
    // reuses the capture module's TANA_* config as the render target unless
    // overridden with a BRIEFING_TANA_WORKSPACE_ID.
    if (fastify.config.ENABLE_BRIEFING) {
      api.log.info('Briefing module enabled');
      await api.register(briefingPlugin, {
        migrationsDir: join(__dirname, '../../../packages/briefing/migrations'),
        disableMigrations: fastify.config.DISABLE_MIGRATIONS,
        briefingConfig: {
          anthropicApiKey: fastify.config.ANTHROPIC_API_KEY,
          classifierModel: fastify.config.CAPTURE_CLASSIFIER_MODEL,
          timeZone: fastify.config.BRIEFING_TIMEZONE,
          gwsAxiBin: fastify.config.BRIEFING_GWS_AXI_BIN,
          // BRIEFING_HQ_AXI_BIN is a deprecated alias, honored only when the
          // generic var is unset so existing deployments keep working.
          commitmentsBin:
            fastify.config.BRIEFING_COMMITMENTS_BIN ?? fastify.config.BRIEFING_HQ_AXI_BIN,
          commitmentsArgs: fastify.config.BRIEFING_COMMITMENTS_ARGS.split(' ')
            .map((a) => a.trim())
            .filter(Boolean),
          calendarAccount: fastify.config.BRIEFING_CALENDAR_ACCOUNT,
          tanaMcpUrl: fastify.config.TANA_MCP_URL,
          tanaMcpToken: fastify.config.TANA_MCP_TOKEN,
          tanaWorkspaceId:
            fastify.config.BRIEFING_TANA_WORKSPACE_ID ?? fastify.config.TANA_WORKSPACE_ID,
          pageBaseUrl: fastify.config.BRIEFING_PAGE_BASE_URL,
          briefingCron: fastify.config.BRIEFING_CRON,
          alertCron: fastify.config.BRIEFING_ALERT_CRON,
          alertWindowMinutes: fastify.config.BRIEFING_ALERT_WINDOW_MINUTES,
          disableBriefing: fastify.config.DISABLE_SYNCS || fastify.config.BRIEFING_DISABLE,
          disableAlerts: fastify.config.DISABLE_SYNCS || fastify.config.BRIEFING_DISABLE_ALERTS,
          // Per-meeting briefings (preps on the virtuous cycle)
          disableMeetingBriefings:
            fastify.config.DISABLE_SYNCS || !fastify.config.ENABLE_MEETING_BRIEFINGS,
          meetingPrepModel: fastify.config.MEETING_PREP_MODEL,
          meetingContextBin: fastify.config.MEETING_CONTEXT_BIN,
          meetingContextArgs: fastify.config.MEETING_CONTEXT_ARGS.split(' ')
            .map((a) => a.trim())
            .filter(Boolean),
          meetingCron: fastify.config.MEETING_CRON,
          meetingRefreshAheadHours: fastify.config.MEETING_REFRESH_AHEAD_HOURS,
          // Stock-aware suggestion seam: the merged sheet+pushed+promoted
          // recipe view decorated by the kitchen module (registered above).
          // Absent → the briefing source falls back to DB-persisted recipes.
          kitchenRecipesProvider: api.kitchenRecipes
            ? () =>
                api.kitchenRecipes!.listAll().then((recipes) =>
                  recipes.map((r) => ({
                    name: r.name,
                    component_labels: r.components.map((c) => c.label),
                  }))
                )
            : undefined,
        },
      });
    } else {
      api.log.info('Briefing module disabled');
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
        contextCommands: parseContextCommands(
          fastify.config.CHAT_CONTEXT_COMMANDS,
          fastify.log,
        ),
        maxTurns: fastify.config.CHAT_MAX_TURNS,
      },
    });
  }
} else {
  fastify.log.info('Chat module disabled');
}

// Public share routes — bypass Caddy basic-auth via /share/* path pattern
await fastify.register(registerPublicShareRoutes);

// Pages public serving surface — GET /pages, /pages/:slug, /pages/_helper.js.
// Same auth posture as the rest of the app (Tailscale-reachable only, no
// bypass); registered outside /api since these serve HTML, not JSON.
if (fastify.config.ENABLE_PAGES) {
  await fastify.register(registerPagesPublicRoutes, { baseUrl: fastify.config.PAGES_BASE_URL });
}

// Serve admin frontend static files
await fastify.register(fastifyStatic, {
  root: join(__dirname, '../../admin/dist'),
  prefix: '/',
});

// Unmatched routes (specs/behaviors/http-not-found.md). The SPA shell answers
// browser NAVIGATIONS to client-side routes and nothing else: an unmatched API
// path, any non-GET/HEAD verb, and any JSON-preferring client each get a real
// 404. Serving the HTML shell with a 200 to, say, `DELETE /kitchen/recipes/<id>`
// tells an API client a write succeeded that never happened.
fastify.setNotFoundHandler((request, reply) => {
  if (resolveUnmatched({ method: request.method, url: request.url, accept: request.headers.accept }) === 'json-404') {
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
