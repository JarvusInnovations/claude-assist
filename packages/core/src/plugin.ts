import type { FastifyPluginAsync, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type postgres from 'postgres';
import type { Scheduler } from './scheduler.js';

/**
 * Extended Fastify instance with claude-assist decorators
 */
declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
  }
}

export interface PluginOptions {
  /** Name of the plugin for logging */
  name: string;
  /** Directory containing SQL migration files */
  migrationsDir?: string;
  /** Database schema to use (default: plugin name) */
  schema?: string;
  /** Skip running migrations on startup */
  disableMigrations?: boolean;
  /** Configuration for sessions plugin */
  sessionsConfig?: SessionsPluginConfig;
  /** Configuration for google plugin */
  googleConfig?: GooglePluginConfig;
  /** Configuration for chat plugin */
  chatConfig?: ChatPluginConfig;
}

/**
 * Configuration for the sessions plugin
 */
export interface SessionsPluginConfig {
  /** Original Claude directory path (for Docker path translation) */
  originalClaudeDir?: string;
  /** Minimum file size to process */
  minFileSize?: number;
  /** Anthropic API key for AI features */
  anthropicApiKey?: string;
  /** Concurrency for outline generation */
  outlineConcurrency?: number;
  /** Disable local filesystem scanning */
  disableLocalIngest?: boolean;
  /** Disable AI outline generation */
  disableGenerateOutlines?: boolean;
}

/**
 * Configuration for the google plugin
 */
/**
 * Configuration for the chat plugin
 */
export interface ChatPluginConfig {
  /** Slack bot token */
  slackBotToken: string;
  /** Slack app-level token for Socket Mode (xapp-...) */
  slackAppToken: string;
  /** Slack signing secret */
  slackSigningSecret: string;
  /** Slack user ID of the owner */
  ownerSlackUserId?: string;
  /** Path to the agent's repo (contains CLAUDE.md, skills, protocols) */
  agentRepoPath: string;
  /** Bot username for chat platforms */
  botUsername?: string;
  /** Claude OAuth token for Max subscription */
  claudeOauthToken?: string;
  /** MCP server configurations */
  mcpServers?: Record<string, { command: string; args: string[] }>;
}

export interface GooglePluginConfig {
  /** Google OAuth client ID */
  clientId: string;
  /** Google OAuth client secret */
  clientSecret: string;
  /** OAuth redirect URI */
  redirectUri: string;
  /** Anthropic API key for AI triage */
  anthropicApiKey?: string;
  /** Concurrency for email triage */
  triageConcurrency?: number;
  /** Disable Gmail sync */
  disableEmailSync?: boolean;
  /** Disable AI email triage */
  disableEmailTriage?: boolean;
}

export interface ModulePlugin {
  plugin: FastifyPluginAsync<PluginOptions>;
  options: PluginOptions;
}

/**
 * Create a module plugin that follows claude-assist conventions
 *
 * Provides:
 * - Automatic migration running on startup
 * - Access to sql client via fastify.sql
 * - Access to scheduler via fastify.scheduler
 */
export function createPlugin(
  name: string,
  setup: (
    fastify: FastifyInstance,
    options: PluginOptions
  ) => Promise<void>
): FastifyPluginAsync<Partial<PluginOptions>> {
  const plugin: FastifyPluginAsync<Partial<PluginOptions>> = async (
    fastify,
    opts
  ) => {
    const options: PluginOptions = {
      name,
      schema: opts.schema ?? name,
      migrationsDir: opts.migrationsDir,
      disableMigrations: opts.disableMigrations,
      sessionsConfig: opts.sessionsConfig,
      googleConfig: opts.googleConfig,
      chatConfig: opts.chatConfig,
    };

    fastify.log.info(`Loading plugin: ${name}`);

    // Run migrations if migrations directory is provided (unless disabled)
    if (options.migrationsDir && fastify.sql) {
      if (options.disableMigrations) {
        fastify.log.info(`Skipping migrations for ${name} (disableMigrations=true)`);
      } else {
        const { runMigrations } = await import('./migrations.js');
        const applied = await runMigrations(fastify.sql, {
          migrationsDir: options.migrationsDir,
          schema: options.schema,
        });

        if (applied.length > 0) {
          fastify.log.info(
            { migrations: applied },
            `Applied ${applied.length} migrations for ${name}`
          );
        }
      }
    }

    // Run the plugin setup
    await setup(fastify, options);

    fastify.log.info(`Loaded plugin: ${name}`);
  };

  // Wrap with fastify-plugin to avoid encapsulation
  return fp(plugin, {
    name,
    fastify: '5.x',
    dependencies: [], // Add dependencies as needed
  });
}
