/**
 * Integration tests against a real, throwaway Postgres for the context
 * timeline (specs/behaviors/session-context-window.md's "Timeline" section) —
 * self-skips unless SESSIONS_TEST_DATABASE_URL is set.
 *
 * Setup:
 *   docker run -d --rm --name ca-timeline-pg -e POSTGRES_PASSWORD=x -p 55436:5432 postgres:18
 *   for f in packages/sessions/migrations/*.sql; do
 *     PGPASSWORD=x psql -h localhost -p 55436 -U postgres -d postgres -v ON_ERROR_STOP=1 -f "$f"
 *   done
 *   SESSIONS_TEST_DATABASE_URL=postgres://postgres:x@localhost:55436/postgres bun test packages/sessions/src/timeline.integration.test.ts
 *   docker stop ca-timeline-pg
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { SyncService } from './sync.js';
import { runTimelineBackfillCycle } from './timeline-backfill.js';
import { computeTimelineSegments, downsampleReadings } from './timeline.js';
import { feed, EMPTY_CHECKPOINT } from './incremental-parser.js';

const DB_URL = process.env.SESSIONS_TEST_DATABASE_URL;
const maybeDescribe = DB_URL ? describe : describe.skip;

if (!DB_URL) {
  // eslint-disable-next-line no-console
  console.log('SESSIONS_TEST_DATABASE_URL not set — skipping timeline integration tests.');
}

// ── Transcript-line builders ────────────────────────────────────────────────

function userLine(text: string, ts: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: crypto.randomUUID(),
    parentUuid: null,
    timestamp: ts,
    message: { role: 'user', content: text },
  }) + '\n';
}

function assistantLine(opts: {
  ts: string;
  inputTokens: number;
  parentUuid?: string | null;
  uuid?: string;
}): { line: string; uuid: string } {
  const uuid = opts.uuid ?? crypto.randomUUID();
  return {
    uuid,
    line:
      JSON.stringify({
        type: 'assistant',
        uuid,
        parentUuid: opts.parentUuid ?? null,
        timestamp: opts.ts,
        isSidechain: false,
        message: {
          role: 'assistant',
          model: 'claude-x',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: opts.inputTokens, output_tokens: 5 },
        },
      }) + '\n',
  };
}

function compactBoundaryLine(ts: string, preTokens: number, postTokens: number): string {
  return (
    JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: ts,
      isSidechain: false,
      compactMetadata: { trigger: 'auto', preTokens, postTokens },
    }) + '\n'
  );
}

/** A turn: one user line + one independent (parentUuid: null) assistant
 * reading — every reading is main-chain and "first in chain" by construction,
 * which keeps the oracle math in these tests simple. */
function turn(i: number, baseMs: number): string {
  const ts = new Date(baseMs + i * 1000).toISOString();
  return userLine(`turn ${i}`, ts) + assistantLine({ ts, inputTokens: 1000 + i }).line;
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

maybeDescribe('context timeline — integration (real Postgres)', () => {
  const sql = postgres(DB_URL ?? '');
  let dir: string;
  const createdSessionIds: string[] = [];
  const createdMachineIds = new Set<string>();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ca-timeline-it-'));
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

  async function fetchEvents(sessionId: string) {
    return sql<
      {
        seq: number;
        kind: 'reading' | 'compaction';
        ts: Date | null;
        tokens: number | null;
        trigger: string | null;
        pre_tokens: number | null;
        post_tokens: number | null;
      }[]
    >`SELECT seq, kind, ts, tokens, trigger, pre_tokens, post_tokens FROM sessions.context_events WHERE session_id = ${sessionId}::uuid ORDER BY seq ASC`;
  }

  async function fetchSessionRow(sessionId: string) {
    const [row] = await sql`SELECT * FROM sessions.sessions WHERE id = ${sessionId}::uuid`;
    if (!row) throw new Error(`session ${sessionId} not found`);
    return row;
  }

  it('live ingest appends context_events for a brand-new session, including a real compact_boundary', async () => {
    const mid = machineId('it-tl-live');
    const sync = new SyncService(sql, noopLog, { claudeDir: dir, machineId: mid, minFileSize: 1 });
    const projectDir = join(dir, 'projects', '-p1');
    await Bun.$`mkdir -p ${projectDir}`.quiet();
    const sessionId = crypto.randomUUID();
    const base = Date.parse('2026-01-01T00:00:00Z');

    let content = '';
    for (let i = 0; i < 5; i++) content += turn(i, base);
    content += compactBoundaryLine(new Date(base + 10_000).toISOString(), 900_000, 20_000);
    await writeFile(join(projectDir, `${sessionId}.jsonl`), content);
    createdSessionIds.push(sessionId);

    await sync.syncLocal();

    const row = await fetchSessionRow(sessionId);
    expect(row.timeline_backfill_done).toBe(true); // brand-new session: no backlog

    const events = await fetchEvents(sessionId);
    const readings = events.filter((e) => e.kind === 'reading');
    const compactions = events.filter((e) => e.kind === 'compaction');
    expect(readings).toHaveLength(5);
    expect(readings.map((r) => r.tokens)).toEqual([1000, 1001, 1002, 1003, 1004]);
    expect(compactions).toHaveLength(1);
    expect(compactions[0]!.pre_tokens).toBe(900_000);
    expect(compactions[0]!.post_tokens).toBe(20_000);
    expect(compactions[0]!.trigger).toBe('auto');
  });

  it('a continuity-failure re-ingest replaces context_events, not duplicates them', async () => {
    const mid = machineId('it-tl-continuity');
    const sync = new SyncService(sql, noopLog, { claudeDir: dir, machineId: mid, minFileSize: 1 });
    const projectDir = join(dir, 'projects', '-p2');
    await Bun.$`mkdir -p ${projectDir}`.quiet();
    const sessionId = crypto.randomUUID();
    const base = Date.parse('2026-02-01T00:00:00Z');
    const filePath = join(projectDir, `${sessionId}.jsonl`);

    await writeFile(filePath, turn(0, base) + turn(1, base));
    createdSessionIds.push(sessionId);
    await sync.syncLocal();
    expect(await fetchEvents(sessionId)).toHaveLength(2);

    // Rewrite entirely (not an append) — forces the continuity-failure path.
    await writeFile(filePath, turn(0, base + 100_000) + turn(1, base + 100_000) + turn(2, base + 100_000));
    await sync.syncLocal();

    const events = await fetchEvents(sessionId);
    expect(events).toHaveLength(3); // replaced, not accumulated to 5
    const uniqueSeqs = new Set(events.map((e) => e.seq));
    expect(uniqueSeqs.size).toBe(events.length); // no duplicate seqs
  });

  it('backfill covers a multi-chunk pre-existing session with bounded per-step memory, then hands off to live ingest without duplicates', async () => {
    const mid = machineId('it-tl-backfill');
    // A tiny chunkMaxBytes forces many chunks for a modest transcript, so the
    // backfill genuinely has to walk several chunk rows one at a time.
    const sync = new SyncService(sql, noopLog, { claudeDir: dir, machineId: mid, minFileSize: 1, chunkMaxBytes: 300 });
    const projectDir = join(dir, 'projects', '-p3');
    await Bun.$`mkdir -p ${projectDir}`.quiet();
    const sessionId = crypto.randomUUID();
    const base = Date.parse('2026-03-01T00:00:00Z');
    const filePath = join(projectDir, `${sessionId}.jsonl`);

    const turnCount = 40;
    let fullContent = '';
    for (let i = 0; i < turnCount; i++) fullContent += turn(i, base);
    await writeFile(filePath, fullContent);
    createdSessionIds.push(sessionId);

    // Ingest normally first — this is what a real "session ingested before
    // the timeline feature existed" looks like once the feature ships:
    // chunks and aggregates exist, but (simulated below) no context_events.
    await sync.syncLocal();
    const chunkRows = await sql<{ seq: number }[]>`
      SELECT seq FROM sessions.transcript_chunks WHERE session_id = ${sessionId}::uuid ORDER BY seq ASC
    `;
    expect(chunkRows.length).toBeGreaterThan(5); // genuinely multi-chunk

    // Simulate the pre-existing-session state migration 019 leaves real rows
    // in: no context_events yet, backfill not done, cursor at zero.
    await sql`DELETE FROM sessions.context_events WHERE session_id = ${sessionId}::uuid`;
    await sql`
      UPDATE sessions.sessions SET
        timeline_backfill_done = false,
        timeline_backfill_next_chunk_seq = 0,
        timeline_backfill_checkpoint = NULL
      WHERE id = ${sessionId}::uuid
    `;

    // Oracle: a full single-pass feed() over the whole transcript (fine to
    // concatenate in a TEST for verification — production code never does).
    const { delta: oracle } = feed(EMPTY_CHECKPOINT, fullContent.split('\n').filter((l) => l.length > 0).map((l) => l + '\n'));
    expect(oracle.contextReadings).toHaveLength(turnCount);

    // Run the backfill repeatedly with a tiny budget so it genuinely takes
    // several runs — each processing only one chunk at a time.
    let runs = 0;
    let totalChunksProcessed = 0;
    while (runs < 200) {
      const result = await runTimelineBackfillCycle(sql, 350 /* bytes: less than one chunk */);
      totalChunksProcessed += result.chunksProcessed;
      runs++;
      const row = await fetchSessionRow(sessionId);
      if (row.timeline_backfill_done) break;
    }
    expect(runs).toBeGreaterThan(1); // genuinely took multiple runs
    expect(totalChunksProcessed).toBeGreaterThanOrEqual(chunkRows.length);

    const rowAfterBackfill = await fetchSessionRow(sessionId);
    expect(rowAfterBackfill.timeline_backfill_done).toBe(true);

    const eventsAfterBackfill = await fetchEvents(sessionId);
    expect(eventsAfterBackfill.filter((e) => e.kind === 'reading')).toHaveLength(turnCount);
    expect(eventsAfterBackfill.map((e) => e.tokens).filter((t) => t !== null)).toEqual(
      oracle.contextReadings.map((r) => r.tokens)
    );

    // Now exercise the live-ingest handoff: append more content and sync.
    // Live ingest must write events for the NEW content itself (backfill is
    // already done), with no duplicate seqs against what backfill wrote.
    await appendFile(filePath, turn(turnCount, base) + turn(turnCount + 1, base));
    await sync.syncLocal();

    const finalEvents = await fetchEvents(sessionId);
    const finalReadings = finalEvents.filter((e) => e.kind === 'reading');
    expect(finalReadings).toHaveLength(turnCount + 2);
    const seqs = finalReadings.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
    expect(finalReadings.map((r) => r.tokens)).toEqual(Array.from({ length: turnCount + 2 }, (_, i) => 1000 + i));
  });

  it('an ordinary append made WHILE backfill is still in progress defers to the backfill sweep, which then covers it too', async () => {
    const mid = machineId('it-tl-race');
    const sync = new SyncService(sql, noopLog, { claudeDir: dir, machineId: mid, minFileSize: 1, chunkMaxBytes: 300 });
    const projectDir = join(dir, 'projects', '-p4');
    await Bun.$`mkdir -p ${projectDir}`.quiet();
    const sessionId = crypto.randomUUID();
    const base = Date.parse('2026-04-01T00:00:00Z');
    const filePath = join(projectDir, `${sessionId}.jsonl`);

    let content = '';
    for (let i = 0; i < 20; i++) content += turn(i, base);
    await writeFile(filePath, content);
    createdSessionIds.push(sessionId);
    await sync.syncLocal();

    // Simulate "pre-existing, backfill only partially done": advance the
    // cursor past the first couple of chunks but leave it unfinished.
    await sql`DELETE FROM sessions.context_events WHERE session_id = ${sessionId}::uuid`;
    await sql`
      UPDATE sessions.sessions SET
        timeline_backfill_done = false,
        timeline_backfill_next_chunk_seq = 0,
        timeline_backfill_checkpoint = NULL
      WHERE id = ${sessionId}::uuid
    `;
    await runTimelineBackfillCycle(sql, 350); // partial progress only

    let row = await fetchSessionRow(sessionId);
    expect(row.timeline_backfill_done).toBe(false); // still catching up

    // A live-ingest cycle happens NOW, while backfill is mid-flight — it must
    // NOT write events for its own new content yet.
    await appendFile(filePath, turn(20, base) + turn(21, base));
    await sync.syncLocal();

    const eventsDuringBackfill = await fetchEvents(sessionId);
    // Whatever backfill already wrote stays; live ingest added none of its own.
    const readingsSoFar = eventsDuringBackfill.filter((e) => e.kind === 'reading').length;

    // Run backfill to completion — it must pick up BOTH the originally
    // pre-existing chunks AND the ones live ingest just appended.
    for (let i = 0; i < 200; i++) {
      const result = await runTimelineBackfillCycle(sql, 350);
      row = await fetchSessionRow(sessionId);
      if (row.timeline_backfill_done) break;
      if (result.chunksProcessed === 0 && result.sessionsCompleted === 0) break;
    }
    expect(row.timeline_backfill_done).toBe(true);

    const finalEvents = await fetchEvents(sessionId);
    const finalReadings = finalEvents.filter((e) => e.kind === 'reading');
    expect(finalReadings).toHaveLength(22); // all 22 turns, no gaps, no dupes
    expect(finalReadings.length).toBeGreaterThan(readingsSoFar);
    const seqs = finalReadings.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('endpoint query pipeline: segments + downsampled readings + every compaction + the limit', async () => {
    const mid = machineId('it-tl-endpoint');
    const sync = new SyncService(sql, noopLog, { claudeDir: dir, machineId: mid, minFileSize: 1 });
    const projectDir = join(dir, 'projects', '-p5');
    await Bun.$`mkdir -p ${projectDir}`.quiet();
    const sessionId = crypto.randomUUID();
    createdSessionIds.push(sessionId);

    const day1 = Date.parse('2026-05-01T00:00:00Z');
    const day3 = day1 + 2 * 24 * 60 * 60_000; // a gap of ~2 days

    let content = '';
    for (let i = 0; i < 10; i++) content += turn(i, day1);
    content += compactBoundaryLine(new Date(day1 + 20_000).toISOString(), 800_000, 15_000);
    for (let i = 0; i < 10; i++) content += turn(10 + i, day3);
    await writeFile(join(projectDir, `${sessionId}.jsonl`), content);

    await sync.syncLocal();
    // Set a known limit directly (context-window resolution is exercised
    // elsewhere; this test only needs SOME value to round-trip).
    await sql`UPDATE sessions.sessions SET context_limit_tokens = 200000 WHERE id = ${sessionId}::uuid`;

    // Reproduce exactly what the route handler does.
    const [session] = await sql<{ context_limit_tokens: number | null }[]>`
      SELECT context_limit_tokens FROM sessions.sessions WHERE id = ${sessionId}::uuid
    `;
    const rows = await sql<
      { kind: 'reading' | 'compaction'; ts: string | null; tokens: number | null; trigger: string | null; pre_tokens: number | null; post_tokens: number | null }[]
    >`
      SELECT kind, ts, tokens, trigger, pre_tokens, post_tokens
      FROM sessions.context_events WHERE session_id = ${sessionId}::uuid
      ORDER BY ts ASC NULLS FIRST, seq ASC
    `;
    const allTimestamps = rows.filter((r) => r.ts !== null).map((r) => new Date(r.ts!));
    const segments = computeTimelineSegments(allTimestamps);
    const readings = rows
      .filter((r) => r.kind === 'reading' && r.ts !== null && r.tokens !== null)
      .map((r) => ({ ts: new Date(r.ts!), tokens: r.tokens! }));
    const downsampled = downsampleReadings(readings);
    const compactions = rows.filter((r) => r.kind === 'compaction');

    expect(session!.context_limit_tokens).toBe(200000);
    expect(segments).toHaveLength(2); // the ~2-day gap splits it
    expect(segments[1]!.gapBeforeMs).toBeGreaterThan(24 * 60 * 60_000);
    expect(downsampled).toHaveLength(20); // well under the ~600 ceiling — no-op
    expect(compactions).toHaveLength(1);
    expect(compactions[0]!.pre_tokens).toBe(800_000);
  });
});
