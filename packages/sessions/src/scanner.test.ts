import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionScanner } from './scanner.js';

const SMALL_ID = '11111111-1111-4111-8111-111111111111';
const LARGE_ID = '22222222-2222-4222-8222-222222222222';

function transcriptLine(text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      uuid: crypto.randomUUID(),
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: text },
    }) + '\n'
  );
}

describe('SessionScanner transcript size limit', () => {
  let claudeDir: string;

  beforeEach(async () => {
    claudeDir = await mkdtemp(join(tmpdir(), 'scanner-test-'));
    const projectDir = join(claudeDir, 'projects', '-tmp-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${SMALL_ID}.jsonl`), transcriptLine('hello'));
    await writeFile(
      join(projectDir, `${LARGE_ID}.jsonl`),
      transcriptLine('x'.repeat(4096))
    );
  });

  afterEach(async () => {
    await rm(claudeDir, { recursive: true, force: true });
  });

  it('skips transcripts over maxFileSize without ingesting them', async () => {
    const scanner = new SessionScanner({ claudeDir, minFileSize: 1, maxFileSize: 1024 });
    const discovered = await scanner.discoverAllSessions(new Set());

    expect(discovered.map((s) => s.sessionId)).toEqual([SMALL_ID]);
    expect(scanner.oversized).toHaveLength(1);
    expect(scanner.oversized[0]!.sessionId).toBe(LARGE_ID);
    expect(scanner.oversized[0]!.bytes).toBeGreaterThan(1024);
  });

  it('applies the same limit to the push inventory and loader', async () => {
    const scanner = new SessionScanner({ claudeDir, minFileSize: 1, maxFileSize: 1024 });

    const inventory = await scanner.getSessionInventory();
    expect(inventory.map((i) => i.sessionId)).toEqual([SMALL_ID]);

    const loaded = await scanner.getSessionsByIds(new Set([SMALL_ID, LARGE_ID]));
    expect(loaded.map((s) => s.sessionId)).toEqual([SMALL_ID]);
    expect(scanner.oversized.map((o) => o.sessionId)).toEqual([LARGE_ID]);
  });

  it('resets the oversized report on each scan', async () => {
    const scanner = new SessionScanner({ claudeDir, minFileSize: 1, maxFileSize: 1024 });
    await scanner.discoverAllSessions(new Set());
    await scanner.discoverAllSessions(new Set());
    expect(scanner.oversized).toHaveLength(1);
  });

  it('admits everything under the default limit', async () => {
    const scanner = new SessionScanner({ claudeDir, minFileSize: 1 });
    const discovered = await scanner.discoverAllSessions(new Set());
    expect(discovered).toHaveLength(2);
    expect(scanner.oversized).toEqual([]);
  });
});
