import { describe, it, expect } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { parseSpawnCommand } from './index.js';

function nullLogger(): FastifyBaseLogger {
  const noop = () => {};
  const logger = {} as unknown as Record<string, unknown>;
  for (const m of ['info', 'warn', 'error', 'debug', 'trace', 'fatal']) logger[m] = noop;
  logger.child = () => logger;
  return logger as unknown as FastifyBaseLogger;
}

describe('parseSpawnCommand', () => {
  const log = nullLogger();

  it('returns undefined when unset', () => {
    expect(parseSpawnCommand(undefined, log)).toBeUndefined();
    expect(parseSpawnCommand('', log)).toBeUndefined();
  });

  it('parses a JSON argv array of non-empty strings', () => {
    expect(parseSpawnCommand('["tool","spawn","--preload-file"]', log)).toEqual([
      'tool',
      'spawn',
      '--preload-file',
    ]);
  });

  it('treats malformed input as unset (disabled), never throws', () => {
    expect(parseSpawnCommand('not json', log)).toBeUndefined();
    expect(parseSpawnCommand('{}', log)).toBeUndefined();
    expect(parseSpawnCommand('[]', log)).toBeUndefined();
    expect(parseSpawnCommand('["ok", 3]', log)).toBeUndefined();
    expect(parseSpawnCommand('["ok", ""]', log)).toBeUndefined();
  });
});
