/**
 * Environment configuration for the server
 * Bun automatically loads .env files
 */

export const env = {
  // Server
  PORT: parseInt(process.env.PORT || '3000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Database
  DATABASE_URL:
    process.env.DATABASE_URL ||
    'postgres://claude:dev@localhost:2528/claude_assist',

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // Module enablement (true by default)
  ENABLE_SESSIONS: process.env.ENABLE_SESSIONS ?? 'true',
  ENABLE_GOOGLE: process.env.ENABLE_GOOGLE ?? 'true',

  // Session Outlines (optional - read directly by sessions plugin)
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OUTLINE_CONCURRENCY: parseInt(process.env.OUTLINE_CONCURRENCY || '5', 10),

  // Google OAuth (required for google module)
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI:
    process.env.GOOGLE_REDIRECT_URI ||
    'http://localhost:3000/google/auth/callback',

  // Triage (optional - concurrency for AI triage)
  TRIAGE_CONCURRENCY: parseInt(process.env.TRIAGE_CONCURRENCY || '5', 10),
} as const;

export type Env = typeof env;
