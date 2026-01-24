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
    'postgres://claude:dev@localhost:5432/claude_assist',

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
} as const;

export type Env = typeof env;
