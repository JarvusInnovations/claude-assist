/**
 * Integration tests against a real, throwaway Postgres — CI has no database,
 * so these self-skip unless SESSIONS_TEST_DATABASE_URL is set.
 *
 * Setup:
 *   docker run -d --rm --name ca-backfill-pg -e POSTGRES_PASSWORD=x -p 55434:5432 postgres:18
 *   for f in packages/sessions/migrations/*.sql; do
 *     PGPASSWORD=x psql -h localhost -p 55434 -U postgres -d postgres -v ON_ERROR_STOP=1 -f "$f"
 *   done
 *   SESSIONS_TEST_DATABASE_URL=postgres://postgres:x@localhost:55434/postgres bun test packages/sessions/src/chunk-backfill.integration.test.ts
 *   # when done: docker stop ca-backfill-pg
 */
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import postgres from 'postgres';
import { ChunkBackfillService } from './chunk-backfill.js';
import { TranscriptReader } from './transcript-reader.js';

const DB_URL = process.env.SESSIONS_TEST_DATABASE_URL;
const maybeDescribe = DB_URL ? describe : describe.skip;

if (!DB_URL) {
  // eslint-disable-next-line no-console
  console.log('SESSIONS_TEST_DATABASE_URL not set — skipping chunk-backfill integration tests.');
}

function line(text: string, opts: { uuid?: string; ts?: string } = {}): string {
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

function assistantLine(text: string, uuid = crypto.randomUUID()): string {
  return (
    JSON.stringify({
      type: 'assistant',
      uuid,
      parentUuid: null,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-x',
        content: [{ type: 'text', text }],
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

maybeDescribe('chunk backfill — integration (real Postgres)', () => {
  const sql = postgres(DB_URL ?? '');
  const createdSessionIds: string[] = [];
  const createdMachineIds = new Set<string>();

  afterEach(async () => {
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

  async function insertInlineSession(mid: string, content: string): Promise<string> {
    createdMachineIds.add(mid);
    let [machine] = await sql<{ id: number }[]>`SELECT id FROM sessions.machines WHERE machine_id = ${mid}`;
    if (!machine) {
      [machine] = await sql`
        INSERT INTO sessions.machines (machine_id, hostname, is_localhost) VALUES (${mid}, ${mid}, false) RETURNING id
      `;
    }
    if (!machine) throw new Error('machine insert failed');
    const sessionId = crypto.randomUUID();
    await sql`
      INSERT INTO sessions.sessions (id, machine_id, project_path, started_at, transcript_hash, raw_transcript, storage)
      VALUES (${sessionId}::uuid, ${machine.id}, '/repo', NOW(), 'deadbeef', ${content}, 'inline')
    `;
    createdSessionIds.push(sessionId);
    return sessionId;
  }

  async function fetchSession(id: string) {
    const [row] = await sql`SELECT * FROM sessions.sessions WHERE id = ${id}::uuid`;
    if (!row) throw new Error(`session ${id} not found`);
    return row;
  }

  async function fetchChunks(id: string) {
    return sql`SELECT * FROM sessions.transcript_chunks WHERE session_id = ${id}::uuid ORDER BY seq ASC`;
  }

  it('a small row converts in one run, with byte-length and md5 parity against raw_transcript', async () => {
    const content = line('hello there') + assistantLine('hi yourself');
    const sessionId = await insertInlineSession('bf-small', content);

    const service = new ChunkBackfillService(sql, noopLog, {});
    const result = await service.runOnce();
    expect(result.sessionsFlipped).toBe(1);

    const row = await fetchSession(sessionId);
    expect(row.storage).toBe('chunked');
    expect(row.raw_transcript).toBeNull();
    expect(row.backfill_owned).toBe(true);

    const chunks = await fetchChunks(sessionId);
    const archived = chunks.map((c) => String(c.content)).join('');
    expect(archived).toBe(content);
    expect(Buffer.byteLength(archived, 'utf8')).toBe(Buffer.byteLength(content, 'utf8'));

    const status = await service.status();
    expect(status.converted).toBeGreaterThanOrEqual(1);
    expect(status.failed).toBe(0);
  });

  it('a row bigger than the run budget converts across multiple runs; raw_transcript stays intact until the final flip', async () => {
    let content = '';
    for (let i = 0; i < 80; i++) content += line(`message number ${i} `.repeat(5));
    const sessionId = await insertInlineSession('bf-multirun', content);

    // Deliberately tiny budgets so this genuinely takes several cycles.
    const service = new ChunkBackfillService(sql, noopLog, { sessionBudgetBytes: 800, runBudgetBytes: 800, chunkMaxBytes: 300 });

    let runs = 0;
    let row = await fetchSession(sessionId);
    while (row.storage !== 'chunked' && runs < 50) {
      const result = await service.runOnce();
      expect(result.sessionsFailed).toBe(0);
      row = await fetchSession(sessionId);
      runs++;
      if (row.storage === 'inline' || row.storage === 'catching_up') {
        // Still in progress — raw_transcript must still be the complete
        // record; it is only ever cleared in the same transaction as the flip.
        expect(row.raw_transcript).toBe(content);
      }
    }

    expect(runs).toBeGreaterThan(1); // genuinely took more than one run
    expect(row.storage).toBe('chunked');
    expect(row.raw_transcript).toBeNull();

    const reader = new TranscriptReader(sql);
    expect(await reader.readFull(sessionId)).toBe(content);
  });

  it('multi-byte content: thresholds and slicing operate in bytes, never characters', async () => {
    // 4-byte emoji, repeated — many characters worth far more bytes each.
    const l1 = line('\u{1F642}'.repeat(200));
    const l2 = line('\u{1F680}'.repeat(200));
    const l3 = line('café naïve — em dash');
    const content = l1 + l2 + l3;
    const sessionId = await insertInlineSession('bf-multibyte', content);

    // Budget admits roughly one big line per cycle — if the slicing were
    // character-based instead of byte-based, this would either crash on an
    // invalid UTF-8 cut or silently truncate mid-character.
    const budget = Buffer.byteLength(l1, 'utf8') + 4;
    const service = new ChunkBackfillService(sql, noopLog, { sessionBudgetBytes: budget, runBudgetBytes: budget * 2 });

    let row = await fetchSession(sessionId);
    let runs = 0;
    while (row.storage !== 'chunked' && runs < 20) {
      await service.runOnce();
      row = await fetchSession(sessionId);
      runs++;
    }
    expect(row.storage).toBe('chunked');

    const reader = new TranscriptReader(sql);
    const full = await reader.readFull(sessionId);
    expect(full).toBe(content);
    expect(Buffer.byteLength(full ?? '', 'utf8')).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('a corrupted conversion fails verification, reverts to inline, and is not retried', async () => {
    const content = line('one') + line('two') + line('three');
    const sessionId = await insertInlineSession('bf-corrupt', content);

    // Tiny budget so the conversion spans multiple cycles, giving us a window
    // to corrupt an already-written chunk before the final flip verifies it.
    const service = new ChunkBackfillService(sql, noopLog, { sessionBudgetBytes: Buffer.byteLength(line('one'), 'utf8') + 2, runBudgetBytes: 10_000 });

    await service.runOnce(); // first partial cycle
    const midway = await fetchSession(sessionId);
    expect(midway.storage).toBe('catching_up');

    // Corrupt the already-written chunk content directly — simulating any
    // cause of a chunk/raw divergence (the verification's whole reason to exist).
    const chunksBefore = await fetchChunks(sessionId);
    expect(chunksBefore.length).toBeGreaterThan(0);
    await sql`
      UPDATE sessions.transcript_chunks SET content = 'this is not the same content at all\n'
      WHERE session_id = ${sessionId}::uuid AND seq = ${chunksBefore[0]!.seq}
    `;

    // Drive it to completion — the final cycle's verification must now fail.
    let row = await fetchSession(sessionId);
    let runs = 0;
    while (row.storage === 'catching_up' && runs < 20) {
      await service.runOnce();
      row = await fetchSession(sessionId);
      runs++;
    }

    expect(row.storage).toBe('inline');
    expect(row.raw_transcript).toBe(content); // untouched — never cleared on a failed flip
    expect(row.backfill_owned).toBe(false);
    expect(await fetchChunks(sessionId)).toHaveLength(0); // partial chunks discarded

    const [failure] = await sql`SELECT * FROM sessions.backfill_failures WHERE session_id = ${sessionId}::uuid`;
    expect(failure).toBeTruthy();
    expect(failure!.attempts).toBe(1);

    // A further run must not retry it: candidate query excludes failed rows.
    const before = await fetchSession(sessionId);
    const result = await service.runOnce();
    expect(result.details.some((d) => d.sessionId === sessionId)).toBe(false);
    const after = await fetchSession(sessionId);
    expect(after.storage).toBe(before.storage);
  });

  it('skips a catching_up row local sync owns, and a row already chunked', async () => {
    const localOwnedContent = line('local sync is handling this one');
    const localOwnedId = await insertInlineSession('bf-skip-local', localOwnedContent);
    // Simulate local sync having already started its own catch-up on this row
    // (backfill_owned defaults to FALSE — this is exactly what local sync's
    // own inline->catching_up transition leaves behind).
    await sql`
      UPDATE sessions.sessions
      SET storage = 'catching_up', ingested_bytes = 0, catchup_threshold_bytes = ${Buffer.byteLength(localOwnedContent, 'utf8')}
      WHERE id = ${localOwnedId}::uuid
    `;

    const alreadyChunkedContent = line('already done');
    const chunkedId = await insertInlineSession('bf-skip-chunked', alreadyChunkedContent);
    await sql`UPDATE sessions.sessions SET storage = 'chunked', raw_transcript = NULL WHERE id = ${chunkedId}::uuid`;

    const service = new ChunkBackfillService(sql, noopLog, {});
    const result = await service.runOnce();

    expect(result.details.some((d) => d.sessionId === localOwnedId)).toBe(false);
    expect(result.details.some((d) => d.sessionId === chunkedId)).toBe(false);

    const localOwnedRow = await fetchSession(localOwnedId);
    expect(localOwnedRow.storage).toBe('catching_up');
    expect(localOwnedRow.backfill_owned).toBe(false);
  });

  it('concurrent runs against the same session serialize under the row lock rather than corrupting it', async () => {
    const content = line('race one') + line('race two') + line('race three') + line('race four');
    const sessionId = await insertInlineSession('bf-race', content);

    const service = new ChunkBackfillService(sql, noopLog, { sessionBudgetBytes: 10_000, runBudgetBytes: 10_000 });

    // Two concurrent runs against the exact same (single) candidate — the row
    // lock inside processSessionCycle must serialize them.
    await Promise.all([service.runOnce(), service.runOnce()]);

    const row = await fetchSession(sessionId);
    expect(row.storage).toBe('chunked');
    expect(row.raw_transcript).toBeNull();

    const chunks = await fetchChunks(sessionId);
    const seqs = chunks.map((c) => c.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicate seqs
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    const reader = new TranscriptReader(sql);
    expect(await reader.readFull(sessionId)).toBe(content);
  });

  it('the read layer is byte-identical before and after conversion, across a few sessions', async () => {
    const samples = [
      line('short one'),
      line('a slightly longer message about parity checks') + assistantLine('and a reply'),
      Array.from({ length: 10 }, (_, i) => line(`message ${i}`)).join(''),
    ];

    const service = new ChunkBackfillService(sql, noopLog, {});
    const reader = new TranscriptReader(sql);

    for (const [i, content] of samples.entries()) {
      const sessionId = await insertInlineSession(`bf-parity-${i}`, content);
      const before = await reader.readFull(sessionId);
      expect(before).toBe(content);

      let row = await fetchSession(sessionId);
      let runs = 0;
      while (row.storage !== 'chunked' && runs < 20) {
        await service.runOnce();
        row = await fetchSession(sessionId);
        runs++;
      }
      expect(row.storage).toBe('chunked');

      const after = await reader.readFull(sessionId);
      expect(after).toBe(before);
      expect(await reader.serialize(sessionId)).toBe(await reader.serialize(sessionId)); // stable, no crash
    }
  });
});
