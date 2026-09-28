/**
 * Integration test for chapter rollups (specs/behaviors/session-outlines.md's
 * "Rollups" section) against a real, throwaway Postgres — CI has no
 * database, so this self-skips unless SESSIONS_TEST_DATABASE_URL is set.
 *
 * Unlike chunked-ingest.integration.test.ts, this writes the session row and
 * its transcript chunk directly with raw SQL rather than going through
 * SyncService: the property under test is OutlineService's rollup pipeline
 * (grouping, budget sharing, exactly-once summarization, compose) against
 * real migrated tables, not ingest itself, and a single hand-built chunk
 * gives exact control over message count without incremental-parser
 * timing/chunking details muddying the picture.
 *
 * The model invoker is a fake, same as the unit tests — this never calls a
 * real model, only real Postgres.
 *
 * Setup:
 *   docker run -d --rm --name ca-rollup-pg -e POSTGRES_PASSWORD=x -p 55437:5432 postgres:18
 *   for f in packages/sessions/migrations/*.sql; do
 *     PGPASSWORD=x psql -h localhost -p 55437 -U postgres -d postgres -v ON_ERROR_STOP=1 -f "$f"
 *   done
 *   SESSIONS_TEST_DATABASE_URL=postgres://postgres:x@localhost:55437/postgres bun test packages/sessions/src/outline-rollups.integration.test.ts
 *   docker stop ca-rollup-pg
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'bun:test';
import postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { ModelInvoker, InvokeRequest, InvokeResult } from '@jarvus/claude-assist-core';
import { OutlineService } from './outline.js';

const DB_URL = process.env.SESSIONS_TEST_DATABASE_URL;
const maybeDescribe = DB_URL ? describe : describe.skip;

if (!DB_URL) {
  // eslint-disable-next-line no-console
  console.log('SESSIONS_TEST_DATABASE_URL not set — skipping outline-rollups integration tests.');
}

const noopLog = {
  info: () => {},
  warn: () => {},
  error: (...args: unknown[]) => console.error(...args),
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLog,
} as unknown as FastifyBaseLogger;

/** A fake invoker: deterministic, distinguishable-by-task text, never a real model call. */
function makeFakeInvoker(): {
  invoker: ModelInvoker;
  callsByTask: Record<string, number>;
  lastPromptByTask: Record<string, string>;
} {
  const callsByTask: Record<string, number> = {};
  const lastPromptByTask: Record<string, string> = {};
  const invoker: ModelInvoker = {
    enabled: true,
    async invoke(req: InvokeRequest): Promise<InvokeResult> {
      callsByTask[req.task] = (callsByTask[req.task] ?? 0) + 1;
      const prompt = typeof req.messages[0]?.content === 'string' ? req.messages[0].content : '';
      lastPromptByTask[req.task] = prompt;
      let text: string;
      if (req.task === 'sessions.outline.compose') {
        text = `<title>composed title</title>\n<summary>composed summary</summary>`;
      } else if (req.task === 'sessions.outline.window') {
        text = 'window summary';
      } else if (req.task === 'sessions.outline.rollup') {
        text = 'chapter summary';
      } else {
        text = `<title>short title</title>\n<summary>short summary</summary>`;
      }
      return {
        text,
        model: 'test-extract-model',
        tier: req.tier,
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 },
        attempts: 1,
        durationMs: 1,
      };
    },
    async invokeTagged() {
      throw new Error('not used in this test');
    },
    modelFor: () => 'test-extract-model',
    async spend() {
      throw new Error('not used in this test');
    },
  };
  return { invoker, callsByTask, lastPromptByTask };
}

/** N alternating user/assistant JSONL lines, one second apart — enough shape for parseMessages/serializeMessageSlice. */
function buildContent(n: number): { content: string; hash: string } {
  const lines: string[] = [];
  const base = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const ts = new Date(base + i * 1000).toISOString();
    const uuid = `m${i}`;
    if (i % 2 === 0) {
      lines.push(
        JSON.stringify({
          type: 'user',
          uuid,
          parentUuid: null,
          timestamp: ts,
          message: { role: 'user', content: `message ${i}` },
        })
      );
    } else {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          uuid,
          parentUuid: null,
          timestamp: ts,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `reply ${i}` }],
            usage: { input_tokens: 5, output_tokens: 5 },
          },
        })
      );
    }
  }
  const content = lines.join('\n') + '\n';
  return { content, hash: createHash('md5').update(content).digest('hex') };
}

maybeDescribe('outline rollups — integration (real Postgres)', () => {
  const sql = postgres(DB_URL ?? '');
  const createdSessionIds: string[] = [];
  const createdMachineDbIds: number[] = [];

  afterAll(async () => {
    for (const id of createdSessionIds) {
      await sql`DELETE FROM sessions.sessions WHERE id = ${id}::uuid`;
    }
    for (const id of createdMachineDbIds) {
      await sql`DELETE FROM sessions.machines WHERE id = ${id}`;
    }
    await sql.end();
  });

  /** Write a session row + one transcript chunk covering `n` synthetic messages, bypassing SyncService for exact control over message count. */
  async function insertSyntheticSession(n: number): Promise<{ sessionId: string; transcriptHash: string }> {
    const { content, hash } = buildContent(n);
    const byteLength = Buffer.byteLength(content, 'utf8');

    const [machine] = await sql<{ id: number }[]>`
      INSERT INTO sessions.machines (machine_id, is_localhost)
      VALUES (${'it-rollups-' + randomUUID()}, false)
      RETURNING id
    `;
    createdMachineDbIds.push(machine!.id);

    const sessionId = randomUUID();
    await sql`
      INSERT INTO sessions.sessions
        (id, machine_id, project_path, git_branch, started_at, transcript_hash, output_tokens, message_count, ingested_bytes)
      VALUES
        (${sessionId}::uuid, ${machine!.id}, '/repo/rollup-it', 'main', NOW(), ${hash}, ${n * 5}, ${n}, ${byteLength})
    `;
    createdSessionIds.push(sessionId);

    await sql`
      INSERT INTO sessions.transcript_chunks
        (session_id, seq, byte_start, byte_end, msg_seq_start, msg_seq_end, content, content_hash)
      VALUES
        (${sessionId}::uuid, 0, 0, ${byteLength}, 0, ${n - 1}, ${content}, ${hash})
    `;

    return { sessionId, transcriptHash: hash };
  }

  it(
    'a session with hundreds of windows composes within the budget across sweeps, with each window and rollup summarized exactly once',
    async () => {
      // 1500 messages / maxMessages=5 -> 300 windows (several hundred, per
      // the plan). rollupFanin=10 -> 30 level-1 chapters -> 3 level-2
      // rollups (30/10), too few (3 < 10) to climb to level 3. sweepCap=25
      // forces this across many budget-limited sweeps: 300 + 30 + 3 = 333
      // summarization units, 25 per sweep.
      const N = 1500;
      const { sessionId, transcriptHash } = await insertSyntheticSession(N);
      const { invoker, callsByTask, lastPromptByTask } = makeFakeInvoker();
      const svc = new OutlineService(sql, noopLog, {
        invoker,
        windowConfig: { thresholdMessages: 50, maxMessages: 5, sweepCap: 25, rollupFanin: 10 },
      });

      let caughtUp = false;
      for (let i = 0; i < 60 && !caughtUp; i++) {
        await svc.generateOutlinesSync([sessionId]);
        const [row] = await sql<{ outline_hash: string | null }[]>`
          SELECT outline_hash FROM sessions.sessions WHERE id = ${sessionId}::uuid
        `;
        caughtUp = row?.outline_hash === transcriptHash;
      }

      expect(caughtUp).toBe(true);

      const windows = await sql<{ status: string }[]>`
        SELECT status FROM sessions.outline_windows WHERE session_id = ${sessionId}::uuid
      `;
      expect(windows).toHaveLength(300);
      expect(windows.every((w) => w.status === 'summarized')).toBe(true);

      const level1 = await sql<{ status: string }[]>`
        SELECT status FROM sessions.outline_rollups WHERE session_id = ${sessionId}::uuid AND level = 1
      `;
      expect(level1).toHaveLength(30);
      expect(level1.every((r) => r.status === 'summarized')).toBe(true);

      const level2 = await sql<{ status: string }[]>`
        SELECT status FROM sessions.outline_rollups WHERE session_id = ${sessionId}::uuid AND level = 2
      `;
      expect(level2).toHaveLength(3);
      expect(level2.every((r) => r.status === 'summarized')).toBe(true);

      // No level 3 - too few level-2 rollups (3 < fanin 10) to ever group.
      const level3 = await sql`
        SELECT 1 FROM sessions.outline_rollups WHERE session_id = ${sessionId}::uuid AND level = 3
      `;
      expect(level3).toHaveLength(0);

      // Exactly once each: total model calls equal the total row count, never more.
      expect(callsByTask['sessions.outline.window']).toBe(300);
      expect(callsByTask['sessions.outline.rollup']).toBe(33); // 30 + 3

      const [finalRow] = await sql<{ outline: string | null; title: string | null; outline_windows_hash: string | null }[]>`
        SELECT outline, title, outline_windows_hash FROM sessions.sessions WHERE id = ${sessionId}::uuid
      `;
      expect(finalRow!.outline).toContain('composed summary');
      expect(finalRow!.title).toBe('composed title');
      expect(finalRow!.outline_windows_hash).not.toBeNull();

      // The final compose call read from the top-level (level-2) chapters,
      // not raw windows — proof the hierarchy actually bounded the input.
      const composePrompt = lastPromptByTask['sessions.outline.compose']!;
      expect(composePrompt).toContain('<chapter level="2" index="0"');
      expect(composePrompt).toContain('<chapter level="2" index="1"');
      expect(composePrompt).toContain('<chapter level="2" index="2"');
      expect(composePrompt).not.toContain('<window ');
      expect(composePrompt).not.toContain('<chapter level="1"');

      // Fully caught up: a further sweep must not touch the model again at all.
      const before = { ...callsByTask };
      const result = await svc.generateOutlinesSync([sessionId]);
      expect(result.sessionsProcessed).toBe(0);
      expect(callsByTask).toEqual(before);
    },
    30_000
  );
});
