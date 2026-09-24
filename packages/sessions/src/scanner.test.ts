import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionScanner } from './scanner.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

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

describe('SessionScanner.listLocalTranscripts', () => {
  let claudeDir: string;
  let projectDir: string;

  beforeEach(async () => {
    claudeDir = await mkdtemp(join(tmpdir(), 'scanner-test-'));
    projectDir = join(claudeDir, 'projects', '-tmp-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${ID_A}.jsonl`), transcriptLine('hello'));
    // A "session" much larger than any legacy size skip would have allowed —
    // the whole point of chunked ingest is that this is no longer special.
    await writeFile(join(projectDir, `${ID_B}.jsonl`), transcriptLine('x'.repeat(200_000)));
  });

  afterEach(async () => {
    await rm(claudeDir, { recursive: true, force: true });
  });

  it('lists every transcript regardless of size — no size skip', async () => {
    const scanner = new SessionScanner({ claudeDir, minFileSize: 1 });
    const files = [];
    for await (const f of scanner.listLocalTranscripts()) files.push(f);
    expect(files.map((f) => f.sessionId).sort()).toEqual([ID_A, ID_B].sort());
    const big = files.find((f) => f.sessionId === ID_B)!;
    expect(big.size).toBeGreaterThan(150_000);
  });

  it('does not fail on unreadable content — stat only, no parse', async () => {
    await writeFile(join(projectDir, `${ID_A}.jsonl`), 'not even json, just bytes\n'.repeat(5));
    const scanner = new SessionScanner({ claudeDir, minFileSize: 1 });
    const files = [];
    for await (const f of scanner.listLocalTranscripts()) files.push(f);
    const a = files.find((f) => f.sessionId === ID_A)!;
    expect(a.size).toBeGreaterThan(0);
  });

  it('skips subagent files (non-UUID names) and anything under minFileSize', async () => {
    await writeFile(join(projectDir, 'agent-abc123.jsonl'), transcriptLine('subagent'));
    const scanner = new SessionScanner({ claudeDir, minFileSize: 1_000_000 });
    const files = [];
    for await (const f of scanner.listLocalTranscripts()) files.push(f);
    expect(files).toEqual([]); // everything is under the (deliberately huge) minFileSize
  });
});

describe('SessionScanner.getSessionInventory', () => {
  let claudeDir: string;

  beforeEach(async () => {
    claudeDir = await mkdtemp(join(tmpdir(), 'scanner-test-'));
    const projectDir = join(claudeDir, 'projects', '-tmp-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${ID_A}.jsonl`), transcriptLine('hello'));
  });

  afterEach(async () => {
    await rm(claudeDir, { recursive: true, force: true });
  });

  it('reports on-disk size instead of a whole-file hash', async () => {
    const scanner = new SessionScanner({ claudeDir, minFileSize: 1 });
    const inventory = await scanner.getSessionInventory();
    expect(inventory).toHaveLength(1);
    expect(inventory[0]!.sessionId).toBe(ID_A);
    expect(inventory[0]!.size).toBeGreaterThan(0);
    expect(inventory[0]!.transcriptHash).toBeUndefined();
  });

  it('suppresses a session matching an ignore marker', async () => {
    const claudeDir2 = await mkdtemp(join(tmpdir(), 'scanner-test-'));
    const projectDir2 = join(claudeDir2, 'projects', '-tmp-project');
    await mkdir(projectDir2, { recursive: true });
    await writeFile(join(projectDir2, `${ID_B}.jsonl`), transcriptLine('AUTOMATED_MARKER task'));
    try {
      const scanner = new SessionScanner({
        claudeDir: claudeDir2,
        minFileSize: 1,
        ignoreContentMarkers: ['AUTOMATED_MARKER'],
      });
      const inventory = await scanner.getSessionInventory();
      expect(inventory).toEqual([]);
    } finally {
      await rm(claudeDir2, { recursive: true, force: true });
    }
  });
});

describe('SessionScanner.getSessionsByIds', () => {
  let claudeDir: string;
  let projectDir: string;
  const FULL_CONTENT = transcriptLine('first') + transcriptLine('second') + transcriptLine('third');

  beforeEach(async () => {
    claudeDir = await mkdtemp(join(tmpdir(), 'scanner-test-'));
    projectDir = join(claudeDir, 'projects', '-tmp-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${ID_A}.jsonl`), FULL_CONTENT);
  });

  afterEach(async () => {
    await rm(claudeDir, { recursive: true, force: true });
  });

  it('sends the whole file from byte zero when there is no baseline', async () => {
    const scanner = new SessionScanner({ claudeDir, minFileSize: 1 });
    const [session] = await scanner.getSessionsByIds(new Set([ID_A]));
    expect(session!.transcript).toBe(FULL_CONTENT);
    expect(session!.sinceBytes).toBe(0);
  });

  it('sends only the tail after the given baseline offset', async () => {
    const scanner = new SessionScanner({ claudeDir, minFileSize: 1 });
    const firstLineBytes = Buffer.byteLength(transcriptLine('first'), 'utf8');
    const [session] = await scanner.getSessionsByIds(new Set([ID_A]), {
      [ID_A]: { ingestedBytes: firstLineBytes, lastChunkHash: null },
    });
    expect(session!.sinceBytes).toBe(firstLineBytes);
    expect(session!.transcript).toBe(FULL_CONTENT.slice(firstLineBytes));
  });

  it('omits a session with nothing new past its baseline', async () => {
    const scanner = new SessionScanner({ claudeDir, minFileSize: 1 });
    const fullBytes = Buffer.byteLength(FULL_CONTENT, 'utf8');
    const sessions = await scanner.getSessionsByIds(new Set([ID_A]), {
      [ID_A]: { ingestedBytes: fullBytes, lastChunkHash: null },
    });
    expect(sessions).toEqual([]);
  });

  it('caps a large read at maxBytesPerSession, cut at the last newline', async () => {
    const scanner = new SessionScanner({ claudeDir, minFileSize: 1 });
    const firstLineBytes = Buffer.byteLength(transcriptLine('first'), 'utf8');
    const [session] = await scanner.getSessionsByIds(
      new Set([ID_A]),
      {},
      firstLineBytes + 1 // enough for the first line, not the second
    );
    expect(session!.transcript).toBe(FULL_CONTENT.slice(0, firstLineBytes));
  });
});
