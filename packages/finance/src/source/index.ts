/**
 * Source selection. One config value decides which implementation the rest of
 * the module talks to; nothing downstream knows or cares which it got.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { FinancePluginConfig } from '@jarvus/claude-assist-core';
import type { FinanceSource } from './types.js';
import { ApiFinanceSource, type SessionStore } from './api-source.js';
import { CommandFinanceSource } from './command-source.js';

export function createFinanceSource(
  config: FinancePluginConfig,
  sessions: SessionStore,
  log: FastifyBaseLogger,
): FinanceSource {
  if (config.sourceMode === 'command') {
    return new CommandFinanceSource(
      {
        ...(config.sourceCommand ? { command: config.sourceCommand } : {}),
        ...(config.sourceCommandTimeoutMs !== undefined
          ? { timeoutMs: config.sourceCommandTimeoutMs }
          : {}),
      },
      log,
    );
  }
  return new ApiFinanceSource(
    {
      ...(config.apiBaseUrl ? { baseUrl: config.apiBaseUrl } : {}),
      ...(config.apiEmail ? { email: config.apiEmail } : {}),
      ...(config.apiPassword ? { password: config.apiPassword } : {}),
      ...(config.apiTotpSecret ? { totpSecret: config.apiTotpSecret } : {}),
      ...(config.apiToken ? { token: config.apiToken } : {}),
    },
    sessions,
    log,
  );
}

export * from './types.js';
export { ApiFinanceSource, mapAccount, mapTransaction, type SessionStore } from './api-source.js';
export { CommandFinanceSource, normalizeTransaction } from './command-source.js';
export { base32Decode, totpCode } from './totp.js';
export * from './documents.js';
