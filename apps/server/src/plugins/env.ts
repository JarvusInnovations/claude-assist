import fp from 'fastify-plugin';
import fastifyEnv from '@fastify/env';
import type { FastifyInstance } from 'fastify';

/**
 * JSON Schema for environment variable validation
 * All env vars must be defined here with types, defaults, and validation
 */
const schema = {
  type: 'object',
  required: ['DATABASE_URL'],
  properties: {
    // Server
    PORT: { type: 'number', default: 2529 },
    HOST: { type: 'string', default: '0.0.0.0' },
    NODE_ENV: {
      type: 'string',
      enum: ['development', 'production', 'test'],
      default: 'development',
    },
    LOG_LEVEL: {
      type: 'string',
      enum: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
      default: 'info',
    },

    // Database
    DATABASE_URL: { type: 'string' },
    DISABLE_MIGRATIONS: { type: 'boolean', default: false },

    // Module enablement
    ENABLE_SESSIONS: { type: 'boolean', default: true },
    ENABLE_GOOGLE: { type: 'boolean', default: true },

    // Master sync disable (overrides all individual sync disable flags)
    DISABLE_SYNCS: { type: 'boolean', default: false },

    // Sessions module
    SESSIONS_ORIGINAL_CLAUDE_DIR: { type: 'string' },
    SESSIONS_MIN_FILE_SIZE: { type: 'number', default: 500 },
    SESSIONS_DISABLE_LOCAL_INGEST: { type: 'boolean', default: false },
    SESSIONS_DISABLE_GENERATE_OUTLINES: { type: 'boolean', default: false },
    // Newline-separated transcript substrings; sessions containing any are
    // suppressed from ingest. Appended to built-in defaults (e.g. M87 triage).
    SESSIONS_IGNORE_MARKERS: { type: 'string' },

    // AI Features (optional)
    ANTHROPIC_API_KEY: { type: 'string' },
    OUTLINE_CONCURRENCY: { type: 'number', default: 5 },
    TRIAGE_CONCURRENCY: { type: 'number', default: 5 },

    // Google OAuth
    GOOGLE_CLIENT_ID: { type: 'string' },
    GOOGLE_CLIENT_SECRET: { type: 'string' },
    GOOGLE_REDIRECT_URI: {
      type: 'string',
      default: 'http://localhost:2529/google/auth/callback',
    },
    GOOGLE_DISABLE_EMAIL_SYNC: { type: 'boolean', default: false },
    GOOGLE_DISABLE_EMAIL_TRIAGE: { type: 'boolean', default: false },

    // Chat module
    ENABLE_CHAT: { type: 'boolean', default: false },
    SLACK_BOT_TOKEN: { type: 'string' },
    SLACK_APP_TOKEN: { type: 'string' },
    SLACK_SIGNING_SECRET: { type: 'string' },
    SLACK_OWNER_USER_ID: { type: 'string' },
    AGENT_REPO_PATH: { type: 'string' },
    BOT_USERNAME: { type: 'string' },
    CLAUDE_CODE_OAUTH_TOKEN: { type: 'string' },
  },
} as const;

/**
 * TypeScript module augmentation for type-safe config access
 */
declare module 'fastify' {
  interface FastifyInstance {
    config: {
      // Server
      PORT: number;
      HOST: string;
      NODE_ENV: 'development' | 'production' | 'test';
      LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

      // Database
      DATABASE_URL: string;
      DISABLE_MIGRATIONS: boolean;

      // Module enablement
      ENABLE_SESSIONS: boolean;
      ENABLE_GOOGLE: boolean;

      // Master sync disable
      DISABLE_SYNCS: boolean;

      // Sessions module
      SESSIONS_ORIGINAL_CLAUDE_DIR?: string;
      SESSIONS_MIN_FILE_SIZE: number;
      SESSIONS_DISABLE_LOCAL_INGEST: boolean;
      SESSIONS_DISABLE_GENERATE_OUTLINES: boolean;
      SESSIONS_IGNORE_MARKERS?: string;

      // AI Features
      ANTHROPIC_API_KEY?: string;
      OUTLINE_CONCURRENCY: number;
      TRIAGE_CONCURRENCY: number;

      // Google OAuth
      GOOGLE_CLIENT_ID?: string;
      GOOGLE_CLIENT_SECRET?: string;
      GOOGLE_REDIRECT_URI: string;
      GOOGLE_DISABLE_EMAIL_SYNC: boolean;
      GOOGLE_DISABLE_EMAIL_TRIAGE: boolean;

      // Chat module
      ENABLE_CHAT: boolean;
      SLACK_BOT_TOKEN?: string;
      SLACK_APP_TOKEN?: string;
      SLACK_SIGNING_SECRET?: string;
      SLACK_OWNER_USER_ID?: string;
      AGENT_REPO_PATH?: string;
      BOT_USERNAME?: string;
      CLAUDE_CODE_OAUTH_TOKEN?: string;
    };
  }
}

export default fp(
  async (fastify: FastifyInstance) => {
    await fastify.register(fastifyEnv, {
      confKey: 'config',
      schema,
      dotenv: true,
      ajv: {
        customOptions(ajvInstance) {
          ajvInstance.opts.coerceTypes = true;
          return ajvInstance;
        },
      },
    });
  },
  { name: 'env' }
);
