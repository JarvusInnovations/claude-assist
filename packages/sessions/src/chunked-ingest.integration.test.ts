/**
 * Integration tests against a real, throwaway Postgres — CI has no database
 * (see plans/transcript-chunked-ingest.md's Testing note), so these self-skip
 * unless SESSIONS_TEST_DATABASE_URL is set.
 *
 * Setup (see the plan for the exact recipe):
 *   docker run -d --rm --name ca-chunks-pg -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:18
 *   for f in packages/sessions/migrations/*.sql; do
 *     PGPASSWORD=x psql -h localhost -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 -f "$f"
 *   done
 *   SESSIONS_TEST_DATABASE_URL=postgres://postgres:x@localhost:55432/postgres bun test packages/sessions/src/chunked-ingest.integration.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { SyncService } from './sync.js';
import { TranscriptReader } from './transcript-reader.js';

const DB_URL = process.env.SESSIONS_TEST_DATABASE_URL;
const maybeDescribe = DB_URL ? describe : describe.skip;

if (!DB_URL) {
  // eslint-disable-next-line no-console
  console.log('SESSIONS_TEST_DATABASE_URL not set — skipping chunked-ingest integration tests.');
}

function line(text: string, opts: { model?: string; uuid?: string; ts?: string } = {}): string {
  const uuid = opts.uuid ?? crypto.randomUUID();
  return (
    JSON.stringify({
      type: 'user',
      uuid,
      parentUuid: null,
      timestamp: opts.ts ?? new Date().toISOString(),
      message: { role: 'user', content: text },
    }) + '\n'
  );
}

function assistantToolLine(toolName: string, target: string, uuid = crypto.randomUUID()): string {
  return (
    JSON.stringify({
      type: 'assistant',
      uuid,
      parentUuid: null,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-x',
        content: [{ type: 'tool_use', id: crypto.randomUUID(), name: toolName, input: { file_path: target } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }) + '\n'
  );
}

const noopLog = {
  info: () => {},
  warn: () => {},
  error: (...args: unknown[]) => console.error(...args),
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLog,
} as unknown as import('fastify').FastifyBaseLogger;

maybeDescribe('chunked ingest — integration (real Postgres)', () => {
  const sql = postgres(DB_URL ?? '');
  // A fresh claudeDir per test: local sync's "local machine" is a global
  // singleton (matched by is_localhost, never by machineId — see
  // SyncService.ensureMachine), so sharing one directory across tests would
  // let a later test's scan pick up files an earlier test already ingested
  // and then deleted the DB row for.
  let dir: string;
  const createdSessionIds: string[] = [];
  const createdMachineIds = new Set<string>();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ca-chunks-it-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    for (const id of createdSessionIds.splice(0)) {
      await sql`DELETE FROM sessions.sessions WHERE id = ${id}::uuid`;
    }
    for (const m of createdMachineIds) {
      await sql`DELETE FROM sessions.machines WHERE machine_id = ${m}`;
    }
    createdMachineIds.clear();
  });

  afterAll(async () => {
    await sql.end();
  });

  function machineId(name: string): string {
    createdMachineIds.add(name);
    return name;
  }

  async function fetchSession(id: string) {
    const [row] = await sql`SELECT * FROM sessions.sessions WHERE id = ${id}::uuid`;
    if (!row) throw new Error(`session ${id} not found`);
    return row;
  }

  async function fetchChunks(id: string) {
    return sql`SELECT * FROM sessions.transcript_chunks WHERE session_id = ${id}::uuid ORDER BY seq ASC`;
  }

  async function fetchToolCalls(id: string) {
    return sql`SELECT * FROM sessions.tool_calls WHERE session_id = ${id}::uuid ORDER BY id ASC`;
  }

  it('fresh ingest: a brand-new local session lands as chunked, with the message index populated', async () => {
    const mid = machineId('it-fresh');
    const sync = new SyncService(sql, noopLog, { claudeDir: dir, machineId: mid, disableLocalIngest: false, minFileSize: 1 });

    const projectDir = join(dir, 'projects', '-p1');
    await Bun.$`mkdir -p ${projectDir}`.quiet();
    const sessionId = crypto.randomUUID();
    const u1 = crypto.randomUUID();
    await writeFile(join(projectDir, `${sessionId}.jsonl`), line('hello there', { uuid: u1 }) + assistantToolLine('Read', '/repo/a.ts'));
    createdSessionIds.push(sessionId);

    const result = await sync.syncLocal();
    expect(result.sessionsIngested).toBe(1);

    const row = await fetchSession(sessionId);
    expect(row.storage).toBe('chunked');
    expect(row.raw_transcript).toBeNull();
    expect(Number(row.ingested_bytes)).toBeGreaterThan(0);

    const chunks = await fetchChunks(sessionId);
    expect(chunks.length).toBeGreaterThan(0);

    const msgRows = await sql`SELECT * FROM sessions.transcript_messages WHERE session_id = ${sessionId}::uuid ORDER BY seq ASC`;
    expect(msgRows.some((r) => r.uuid === u1)).toBe(true);

    const toolCalls = await fetchToolCalls(sessionId);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.tool_name).toBe('Read');
  });

  it('append across cycles: a second sync only reads the appended bytes, tool_calls ids stay stable', async () => {
    const mid = machineId('it-append');
    const sync = new SyncService(sql, noopLog, { claudeDir: dir, machineId: mid, minFileSize: 1 });
    const projectDir = join(dir, 'projects', '-p2');
    await Bun.$`mkdir -p ${projectDir}`.quiet();
    const sessionId = crypto.randomUUID();
    const filePath = join(projectDir, `${sessionId}.jsonl`);
    await writeFile(filePath, line('turn one') + assistantToolLine('Read', '/repo/one.ts'));
    createdSessionIds.push(sessionId);

    await sync.syncLocal();
    const afterFirst = await fetchSession(sessionId);
    const firstIngestedBytes = Number(afterFirst.ingested_bytes);
    const firstToolCalls = await fetchToolCalls(sessionId);
    const firstToolCallIds = firstToolCalls.map((r) => r.id);

    await appendFile(filePath, line('turn two') + assistantToolLine('Edit', '/repo/two.ts'));
    const result2 = await sync.syncLocal();
    expect(result2.sessionsUpdated).toBe(1);

    const afterSecond = await fetchSession(sessionId);
    expect(Number(afterSecond.ingested_bytes)).toBeGreaterThan(firstIngestedBytes);

    const secondToolCalls = await fetchToolCalls(sessionId);
    expect(secondToolCalls).toHaveLength(2);
    // The first cycle's tool_calls id is untouched — append-only, never
    // deleted-and-reinserted (the ledger scans by ascending id).
    expect(secondToolCalls[0]!.id).toBe(firstToolCallIds[0]);

    const chunks = await fetchChunks(sessionId);
    expect(chunks.length).toBeGreaterThanOrEqual(2); // at least one chunk per cycle
    expect(chunks[0]!.byte_start).toBe('0');
  });

  it('budgeted catch-up: a file bigger than the ingest budget catches up over multiple cycles', async () => {
    const mid = machineId('it-budget');
    const budget = 2000; // deliberately tiny
    const sync = new SyncService(sql, noopLog, { claudeDir: dir, machineId: mid, minFileSize: 1, ingestBudgetBytes: budget, chunkMaxBytes: 500 });
    const projectDir = join(dir, 'projects', '-p3');
    await Bun.$`mkdir -p ${projectDir}`.quiet();
    const sessionId = crypto.randomUUID();
    const filePath = join(projectDir, `${sessionId}.jsonl`);

    // ~10KB of content — several times the budget.
    let content = '';
    for (let i = 0; i < 60; i++) content += line(`message number ${i} `.repeat(5));
    await writeFile(filePath, content);
    createdSessionIds.push(sessionId);

    let cycles = 0;
    let row = null as Awaited<ReturnType<typeof fetchSession>> | null;
    while (cycles < 20) {
      await sync.syncLocal();
      row = await fetchSession(sessionId);
      cycles++;
      if (Number(row.ingested_bytes) >= Buffer.byteLength(content, 'utf8')) break;
    }

    expect(cycles).toBeGreaterThan(1); // genuinely took more than one cycle
    expect(Number(row!.ingested_bytes)).toBe(Buffer.byteLength(content, 'utf8'));
    expect(row!.storage).toBe('chunked');

    // The read layer sees the complete, correctly-ordered content once caught up.
    const reader = new TranscriptReader(sql);
    const full = await reader.readFull(sessionId);
    expect(full).toBe(content);
  });

  it('legacy inline -> catching_up -> chunked: raw_transcript stays intact until chunks fully cover it', async () => {
    const mid = 'it-inline';
    createdMachineIds.add(mid);
    const [machine] = await sql`
      INSERT INTO sessions.machines (machine_id, hostname, is_localhost) VALUES (${mid}, ${mid}, true) RETURNING id
    `;
    if (!machine) throw new Error('machine insert failed');
    const sessionId = crypto.randomUUID();
    const originalContent = line('legacy message one') + line('legacy message two');
    await sql`
      INSERT INTO sessions.sessions (id, machine_id, project_path, started_at, transcript_hash, raw_transcript, storage)
      VALUES (${sessionId}::uuid, ${machine.id}, '/repo', NOW(), 'deadbeef', ${originalContent}, 'inline')
    `;
    createdSessionIds.push(sessionId);

    const projectDir = join(dir, 'projects', '-p4');
    await Bun.$`mkdir -p ${projectDir}`.quiet();
    const filePath = join(projectDir, `${sessionId}.jsonl`);
    // The on-disk file has grown beyond what raw_transcript captured.
    const grownContent = originalContent + line('legacy message three (new)');
    await writeFile(filePath, grownContent);

    // Smaller than the threshold (originalContent's length), so the first
    // cycle genuinely can't reach it — cutAtLastNewline stops at the first
    // line only, leaving the row in catching_up for at least one more cycle.
    const budget = Buffer.byteLength(line('legacy message one'), 'utf8') + 2;
    const sync = new SyncService(sql, noopLog, { claudeDir: dir, machineId: mid, minFileSize: 1, ingestBudgetBytes: budget });

    await sync.syncLocal();
    const mid1 = await fetchSession(sessionId);
    expect(mid1.storage).toBe('catching_up');
    expect(mid1.raw_transcript).toBe(originalContent); // untouched — still the complete record so far

    await sync.syncLocal(); // catches up through the rest of originalContent — flips to chunked
    const mid2 = await fetchSession(sessionId);
    expect(mid2.storage).toBe('chunked');
    expect(mid2.raw_transcript).toBeNull();

    // A generous budget for the final pickup — the tiny catch-up budget above
    // is smaller than the third line itself, which would never make progress.
    const syncNormalBudget = new SyncService(sql, noopLog, { claudeDir: dir, machineId: mid, minFileSize: 1 });
    await syncNormalBudget.syncLocal(); // picks up the third (new, post-transition) line
    const final = await fetchSession(sessionId);
    expect(final.storage).toBe('chunked');

    const reader = new TranscriptReader(sql);
    const full = await reader.readFull(sessionId);
    expect(full).toBe(grownContent);
  });

  it('continuity failure triggers a full re-ingest, replacing chunks in one transaction', async () => {
    const mid = machineId('it-continuity');
    const sync = new SyncService(sql, noopLog, { claudeDir: dir, machineId: mid, minFileSize: 1 });
    const projectDir = join(dir, 'projects', '-p5');
    await Bun.$`mkdir -p ${projectDir}`.quiet();
    const sessionId = crypto.randomUUID();
    const filePath = join(projectDir, `${sessionId}.jsonl`);
    await writeFile(filePath, line('original content'));
    createdSessionIds.push(sessionId);

    await sync.syncLocal();
    const before = await fetchChunks(sessionId);
    expect(before).toHaveLength(1);
    const originalChunkHash = before[0]!.content_hash;

    // Rewrite the file entirely (not an append) — the last chunk's bytes no
    // longer match on disk.
    const replacement = line('completely different content') + line('and more');
    await writeFile(filePath, replacement);

    await sync.syncLocal();
    const after = await fetchChunks(sessionId);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]!.content_hash).not.toBe(originalChunkHash);

    const reader = new TranscriptReader(sql);
    const full = await reader.readFull(sessionId);
    expect(full).toBe(replacement);
  });

  it('push: accepts both the legacy whole-file payload and the new tail-only payload', async () => {
    const mid = 'it-push';
    createdMachineIds.add(mid);
    const sync = new SyncService(sql, noopLog, {});

    // Legacy client: sends the whole file, no sinceBytes.
    const legacySessionId = crypto.randomUUID();
    const legacyContent = line('pushed from an old satellite CLI');
    createdSessionIds.push(legacySessionId);
    const legacyResult = await sync.processPush({
      machineId: mid,
      hostname: 'old-satellite',
      sessions: [{ sessionId: legacySessionId, transcriptPath: '/remote/path.jsonl', transcript: legacyContent }],
    });
    expect(legacyResult.sessionsIngested).toBe(1);
    const legacyRow = await fetchSession(legacySessionId);
    expect(legacyRow.storage).toBe('chunked');

    // Same satellite, next cycle: legacy client sends the WHOLE file again
    // (grown), still no sinceBytes — server should splice in only the tail
    // rather than reingesting from zero every time.
    const grown = legacyContent + line('a second message from the old client');
    const legacyResult2 = await sync.processPush({
      machineId: mid,
      sessions: [{ sessionId: legacySessionId, transcriptPath: '/remote/path.jsonl', transcript: grown }],
    });
    expect(legacyResult2.sessionsUpdated).toBe(1);
    const chunksAfterLegacyAppend = await fetchChunks(legacySessionId);
    expect(chunksAfterLegacyAppend.length).toBeGreaterThanOrEqual(1);
    const reader = new TranscriptReader(sql);
    expect(await reader.readFull(legacySessionId)).toBe(grown);

    // New-protocol client: inventory round trip, then a tail-only push.
    const newSessionId = crypto.randomUUID();
    createdSessionIds.push(newSessionId);
    const firstPart = line('new-protocol first part');
    await sync.processPush({
      machineId: mid,
      sessions: [{ sessionId: newSessionId, transcriptPath: '/remote/new.jsonl', transcript: firstPart, sinceBytes: 0 }],
    });

    const inventoryResp = await sync.processInventory({
      machineId: mid,
      inventory: [{ sessionId: newSessionId, transcriptPath: '/remote/new.jsonl', size: Buffer.byteLength(firstPart, 'utf8') + 50 }],
    });
    expect(inventoryResp.neededSessionIds).toContain(newSessionId);
    const baseline = inventoryResp.baselines[newSessionId]!;
    expect(baseline.ingestedBytes).toBe(Buffer.byteLength(firstPart, 'utf8'));

    const secondPart = line('new-protocol second part, sent as tail only');
    const pushResult = await sync.processPush({
      machineId: mid,
      sessions: [
        { sessionId: newSessionId, transcriptPath: '/remote/new.jsonl', transcript: secondPart, sinceBytes: baseline.ingestedBytes },
      ],
    });
    expect(pushResult.sessionsUpdated).toBe(1);
    expect(await reader.readFull(newSessionId)).toBe(firstPart + secondPart);
  });

  it('read-layer outputs are identical between inline and chunked storage for the same transcript', async () => {
    const mid = 'it-parity';
    createdMachineIds.add(mid);
    const [machine] = await sql`
      INSERT INTO sessions.machines (machine_id, hostname, is_localhost) VALUES (${mid}, ${mid}, false) RETURNING id
    `;
    if (!machine) throw new Error('machine insert failed');
    const uuidA = crypto.randomUUID();
    const uuidB = crypto.randomUUID();
    const content =
      line('first task here', { uuid: uuidA }) +
      assistantToolLine('Read', '/repo/parity.ts') +
      line('second task about parity checks', { uuid: uuidB }) +
      assistantToolLine('Edit', '/repo/parity.ts');

    const inlineId = crypto.randomUUID();
    createdSessionIds.push(inlineId);
    await sql`
      INSERT INTO sessions.sessions (id, machine_id, project_path, started_at, transcript_hash, raw_transcript, storage)
      VALUES (${inlineId}::uuid, ${machine.id}, '/repo', NOW(), 'aaaa', ${content}, 'inline')
    `;

    // Ingest the identical content as a chunked session via a direct push.
    const chunkedId = crypto.randomUUID();
    createdSessionIds.push(chunkedId);
    const sync = new SyncService(sql, noopLog, {});
    await sync.processPush({
      machineId: mid,
      sessions: [{ sessionId: chunkedId, transcriptPath: '/remote/parity.jsonl', transcript: content }],
    });
    const chunkedRow = await fetchSession(chunkedId);
    expect(chunkedRow.storage).toBe('chunked');

    const reader = new TranscriptReader(sql);
    expect(await reader.readFull(chunkedId)).toBe(await reader.readFull(inlineId));
    expect(await reader.serialize(chunkedId)).toBe(await reader.serialize(inlineId));

    const inlineAround = await reader.readAround(inlineId, uuidA, 1, 1);
    const chunkedAround = await reader.readAround(chunkedId, uuidA, 1, 1);
    expect(chunkedAround.window?.lines).toEqual(inlineAround.window?.lines);

    const inlineFind = await reader.find(inlineId, { match: 'parity', in: 'text' });
    const chunkedFind = await reader.find(chunkedId, { match: 'parity', in: 'text' });
    expect(chunkedFind.matches.map((m) => m.anchor)).toEqual(inlineFind.matches.map((m) => m.anchor));
  });
});
