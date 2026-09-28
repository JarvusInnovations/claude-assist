import { describe, expect, it, mock, spyOn } from 'bun:test';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { ModelInvoker, InvokeRequest, InvokeResult } from '@jarvus/claude-assist-core';
import { OutlineService } from './outline.js';
import { TranscriptReader } from './transcript-reader.js';
import { parseMessages } from './transcript.js';

/**
 * A minimal postgres.js-compatible fake: the tag function returns a
 * "fragment" — carrying its own strings/values and a `.then` — so that
 * nested `sql\`...\`` fragments used as conditional SET clauses (the
 * windowed-update pattern in `processOneSession`) splice their text into the
 * outer query the same way the real library does, before anything executes.
 * Only the outermost `await sql\`...\`` triggers `execute()`.
 */
const FRAGMENT = Symbol('fragment');

interface Fragment {
  [FRAGMENT]: true;
  strings: TemplateStringsArray;
  values: unknown[];
  then: Promise<unknown[]>['then'];
}

function isFragment(v: unknown): v is Fragment {
  return typeof v === 'object' && v !== null && FRAGMENT in v;
}

function flatten(strings: TemplateStringsArray, values: unknown[]): { text: string; vals: unknown[] } {
  let text = strings[0] ?? '';
  const vals: unknown[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isFragment(v)) {
      const nested = flatten(v.strings, v.values);
      text += nested.text;
      vals.push(...nested.vals);
    } else {
      text += '?';
      vals.push(v);
    }
    text += strings[i + 1] ?? '';
  }
  return { text, vals };
}

function makeFakeSql(execute: (text: string, vals: unknown[]) => Promise<unknown[]>): postgres.Sql {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const fragment: Fragment = {
      [FRAGMENT]: true,
      strings,
      values,
      then: (onFulfilled, onRejected) => {
        const { text, vals } = flatten(strings, values);
        return execute(text, vals).then(onFulfilled, onRejected);
      },
    };
    return fragment as unknown as Promise<unknown[]>;
  }) as unknown as postgres.Sql;
  return tag;
}

// ── Fake sessions.sessions + sessions.outline_windows tables ────────────────

interface FakeSession {
  id: string;
  project_path: string | null;
  git_branch: string | null;
  /** The session's full archived transcript content. Test fixture field only
   * — the real schema has no such column; TranscriptReader's chunked backend
   * serves this content via a single fake chunk (see `makeFakeDb`'s
   * transcript_chunks handlers). */
  content: string;
  transcript_hash: string;
  outline: string | null;
  title: string | null;
  outline_hash: string | null;
  outline_attempts: number;
  message_count: number;
  outline_windows_hash: string | null;
  output_tokens: string;
  started_at: string;
}

interface FakeWindow {
  id: string;
  session_id: string;
  window_index: number;
  from_seq: number;
  to_seq: number;
  from_ts: string | null;
  to_ts: string | null;
  closed_at: string | null;
  status: 'pending' | 'summarizing' | 'summarized' | 'failed';
  summary: string | null;
  content_hash: string | null;
  model: string | null;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  summarized_at: string | null;
}

/** A JSONL transcript line and a couple of message builders, matching the parser's expected shape. */
function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}
function userMsg(uuid: string, ts: string, text: string): string {
  return line({ type: 'user', uuid, parentUuid: null, timestamp: ts, message: { role: 'user', content: text } });
}
function assistantMsg(uuid: string, ts: string, text: string): string {
  return line({ type: 'assistant', uuid, parentUuid: null, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

/** Build a transcript of N alternating user/assistant messages, one second apart. */
function bigTranscript(n: number): string {
  const lines: string[] = [];
  const base = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const ts = new Date(base + i * 1000).toISOString();
    lines.push(i % 2 === 0 ? userMsg(`u${i}`, ts, `message ${i}`) : assistantMsg(`u${i}`, ts, `reply ${i}`));
  }
  return lines.join('\n');
}

interface FakeRollup {
  id: string;
  session_id: string;
  level: number;
  rollup_index: number;
  from_seq: number;
  to_seq: number;
  from_ts: string | null;
  to_ts: string | null;
  status: 'pending' | 'summarizing' | 'summarized' | 'failed';
  summary: string | null;
  content_hash: string | null;
  model: string | null;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  summarized_at: string | null;
}

let nextWindowId = 1;
let nextRollupId = 1;

function makeLogger(): FastifyBaseLogger {
  return {
    info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}),
    debug: mock(() => {}), fatal: mock(() => {}), trace: mock(() => {}),
    child: () => makeLogger(),
  } as unknown as FastifyBaseLogger;
}

function makeFakeDb(
  sessions: FakeSession[],
  windows: FakeWindow[],
  seen?: { text: string; vals: unknown[] }[],
  rollups: FakeRollup[] = []
): postgres.Sql {
  return makeFakeSql(async (text, vals) => {
    seen?.push({ text, vals });

    // ── OutlineRollupStore — checked ahead of the window-store branches
    // below, since several of their UPDATE queries share matching substrings
    // ("SET status = 'summarizing'", "summarized_at = NOW()", "attempts =
    // attempts + 1", "lease_expires_at < NOW()") and only the table name in
    // the query text tells them apart. ──
    if (text.includes('SELECT id, session_id, level')) {
      const [sessionId] = vals as [string];
      return rollups
        .filter((r) => r.session_id === sessionId)
        .sort((a, b) => a.level - b.level || a.rollup_index - b.rollup_index)
        .map((r) => ({ ...r }));
    }
    if (text.includes('INSERT INTO sessions.outline_rollups')) {
      const [sessionId, level, rollupIndex, fromSeq, toSeq, fromTs, toTs] = vals as [
        string, number, number, number, number, string | null, string | null,
      ];
      const existing = rollups.find((r) => r.session_id === sessionId && r.level === level && r.rollup_index === rollupIndex);
      if (!existing) {
        rollups.push({
          id: String(nextRollupId++),
          session_id: sessionId,
          level,
          rollup_index: rollupIndex,
          from_seq: fromSeq,
          to_seq: toSeq,
          from_ts: fromTs,
          to_ts: toTs,
          status: 'pending',
          summary: null,
          content_hash: null,
          model: null,
          attempts: 0,
          lease_owner: null,
          lease_expires_at: null,
          summarized_at: null,
        });
      }
      return [];
    }
    if (text.includes('sessions.outline_rollups') && text.includes("SET status = 'summarizing'")) {
      const [ownerId, , id] = vals as [string, number, string];
      const r = rollups.find((x) => x.id === id);
      if (!r || r.status !== 'pending') return [];
      r.status = 'summarizing';
      r.lease_owner = ownerId;
      r.lease_expires_at = new Date(Date.now() + 3600_000).toISOString();
      return [{ id: r.id }];
    }
    if (text.includes('sessions.outline_rollups') && text.includes('summarized_at = NOW()')) {
      const [summary, model, contentHash, id] = vals as [string, string, string, string];
      const r = rollups.find((x) => x.id === id);
      if (r) {
        r.status = 'summarized';
        r.summary = summary;
        r.model = model;
        r.content_hash = contentHash;
        r.lease_owner = null;
        r.lease_expires_at = null;
      }
      return [];
    }
    if (text.includes('sessions.outline_rollups') && text.includes('attempts = attempts + 1')) {
      const [, maxAttempts, id] = vals as [string, number, string];
      const r = rollups.find((x) => x.id === id);
      if (r) {
        r.attempts += 1;
        r.lease_owner = null;
        r.lease_expires_at = null;
        r.status = r.attempts >= maxAttempts ? 'failed' : 'pending';
      }
      return [];
    }
    if (text.includes('sessions.outline_rollups') && text.includes('lease_expires_at < NOW()')) {
      const now = Date.now();
      const reclaimed = rollups.filter((r) => r.status === 'summarizing' && r.lease_expires_at && Date.parse(r.lease_expires_at) < now);
      for (const r of reclaimed) {
        r.status = 'pending';
        r.lease_owner = null;
        r.lease_expires_at = null;
      }
      return reclaimed.map((r) => ({ id: r.id }));
    }
    // ── sweep selection ──
    if (text.includes('WHERE outline_hash IS DISTINCT FROM transcript_hash') && text.includes('ORDER BY started_at DESC')) {
      const cap = vals[0] as number;
      return sessions
        .filter((s) => s.outline_hash !== s.transcript_hash && s.outline_attempts < cap)
        .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
        .map((s) => ({ ...s }));
    }

    // ── TranscriptReader.sessionExists ──
    if (text.includes('SELECT id FROM sessions.sessions WHERE id =')) {
      const [id] = vals as [string];
      return sessions.some((x) => x.id === id) ? [{ id }] : [];
    }

    // ── TranscriptReader.rawByteLength ──
    if (text.includes('SELECT ingested_bytes FROM sessions.sessions')) {
      const [id] = vals as [string];
      const s = sessions.find((x) => x.id === id);
      return s ? [{ ingested_bytes: Buffer.byteLength(s.content, 'utf8') }] : [];
    }

    // Every fake session's content lives in one synthetic chunk spanning its
    // whole byte/seq range — these tests care about content correctness, not
    // chunk-boundary edge cases (those live in transcript-reader.test.ts and
    // the integration suite).
    const fakeChunkFor = (id: string) => {
      const s = sessions.find((x) => x.id === id);
      if (!s) return null;
      const messages = parseMessages(s.content);
      return {
        content: s.content,
        byteStart: 0,
        byteEnd: Buffer.byteLength(s.content, 'utf8'),
        msgSeqStart: 0,
        msgSeqEnd: messages.length - 1,
      };
    };

    // ── TranscriptReader.readHeadTail (lastChunk lookup) ──
    if (text.includes('ORDER BY seq DESC LIMIT 1') && text.includes('byte_end')) {
      const [id] = vals as [string];
      const chunk = fakeChunkFor(id);
      return chunk ? [{ byte_end: chunk.byteEnd }] : [];
    }

    // ── TranscriptReader.readHeadTail / readFullChunked (whole content) ──
    if (text.includes('SELECT content FROM sessions.transcript_chunks') && !text.includes('msg_seq_end')) {
      const [id] = vals as [string];
      const chunk = fakeChunkFor(id);
      return chunk ? [{ content: chunk.content }] : [];
    }

    // ── TranscriptReader.messagesSince ──
    if (text.includes('msg_seq_end >=')) {
      const [id, afterSeqPlus1] = vals as [string, number];
      const chunk = fakeChunkFor(id);
      if (!chunk || chunk.msgSeqEnd < afterSeqPlus1) return [];
      return [{ msg_seq_start: chunk.msgSeqStart, content: chunk.content }];
    }

    // ── OutlineService.bumpOutlineAttempts ──
    if (text.includes('outline_attempts = outline_attempts + 1')) {
      const [id] = vals as [string];
      const s = sessions.find((x) => x.id === id);
      if (s) s.outline_attempts += 1;
      return s ? [{ outline_attempts: s.outline_attempts }] : [];
    }

    // ── processOneSession: empty-session / short-pass UPDATE (SET on its own line) ──
    if (text.includes('UPDATE sessions.sessions\n')) {
      const isEmptyWrite = text.includes('outline = NULL');
      if (isEmptyWrite) {
        const [outlineHash, id] = vals as [string, string];
        const s = sessions.find((x) => x.id === id);
        if (s) {
          s.outline = null;
          s.title = null;
          s.outline_hash = outlineHash;
          s.outline_attempts = 0;
        }
        return [];
      }
      const [outline, title, outlineHash, id] = vals as [string, string, string, string];
      const s = sessions.find((x) => x.id === id);
      if (s) {
        s.outline = outline;
        s.title = title;
        s.outline_hash = outlineHash;
        s.outline_attempts = 0;
      }
      return [];
    }

    // ── processOneSession: windowed UPDATE (SET on the same line as the table) ──
    if (text.includes('sessions.sessions SET')) {
      const composed = text.includes('outline_windows_hash');
      const caughtUp = text.includes('outline_hash = ');
      const queue = [...vals];
      let outline: string | undefined, title: string | undefined, windowsHash: string | undefined, transcriptHash: string | undefined;
      if (composed) {
        outline = queue.shift() as string;
        title = queue.shift() as string;
        windowsHash = queue.shift() as string;
      }
      if (caughtUp) {
        transcriptHash = queue.shift() as string;
      }
      const id = queue.shift() as string;
      const s = sessions.find((x) => x.id === id);
      if (s) {
        if (composed) {
          s.outline = outline!;
          s.title = title!;
          s.outline_windows_hash = windowsHash!;
        }
        if (caughtUp) {
          s.outline_hash = transcriptHash!;
        }
        s.outline_attempts = 0;
      }
      return [];
    }

    // ── OutlineWindowStore ──
    if (text.includes('SELECT id, session_id, window_index')) {
      const [sessionId] = vals as [string];
      return windows.filter((w) => w.session_id === sessionId).sort((a, b) => a.window_index - b.window_index).map((w) => ({ ...w }));
    }
    if (text.includes('MAX(to_seq)')) {
      const [sessionId] = vals as [string];
      const closed = windows.filter((w) => w.session_id === sessionId && w.closed_at !== null);
      return [{ to_seq: closed.length ? Math.max(...closed.map((w) => w.to_seq)) : null, closed_count: closed.length }];
    }
    if (text.includes('INSERT INTO sessions.outline_windows')) {
      const [sessionId, windowIndex, fromSeq, toSeq, fromTs, toTs, closed] = vals as [
        string, number, number, number, string | null, string | null, boolean,
      ];
      const existing = windows.find((w) => w.session_id === sessionId && w.window_index === windowIndex);
      if (!existing) {
        windows.push({
          id: String(nextWindowId++),
          session_id: sessionId,
          window_index: windowIndex,
          from_seq: fromSeq,
          to_seq: toSeq,
          from_ts: fromTs,
          to_ts: toTs,
          closed_at: closed ? new Date().toISOString() : null,
          status: 'pending',
          summary: null,
          content_hash: null,
          model: null,
          attempts: 0,
          lease_owner: null,
          lease_expires_at: null,
          summarized_at: null,
        });
      } else if (existing.closed_at === null) {
        existing.to_seq = toSeq;
        existing.to_ts = toTs;
        if (closed) existing.closed_at = new Date().toISOString();
      }
      return [];
    }
    if (text.includes("SET status = 'summarizing'")) {
      const [ownerId, , id] = vals as [string, number, string];
      const w = windows.find((x) => x.id === id);
      if (!w || w.status !== 'pending') return [];
      w.status = 'summarizing';
      w.lease_owner = ownerId;
      w.lease_expires_at = new Date(Date.now() + 3600_000).toISOString();
      return [{ id: w.id }];
    }
    if (text.includes('lease_expires_at < NOW()')) {
      const now = Date.now();
      const reclaimed = windows.filter((w) => w.status === 'summarizing' && w.lease_expires_at && Date.parse(w.lease_expires_at) < now);
      for (const w of reclaimed) { w.status = 'pending'; w.lease_owner = null; w.lease_expires_at = null; }
      return reclaimed.map((w) => ({ id: w.id }));
    }
    if (text.includes("status = 'pending', lease_owner = NULL")) {
      const [id] = vals as [string];
      const w = windows.find((x) => x.id === id);
      if (w) { w.status = 'pending'; w.lease_owner = null; w.lease_expires_at = null; }
      return [];
    }
    if (text.includes('summarized_at = NOW()')) {
      const [status, summary, model, contentHash, id] = vals as [string, string, string, string, string];
      const w = windows.find((x) => x.id === id);
      if (w) {
        w.status = status as FakeWindow['status'];
        w.summary = summary;
        w.model = model;
        w.content_hash = contentHash;
        w.attempts = 0;
        w.lease_owner = null;
        w.lease_expires_at = null;
      }
      return [];
    }
    if (text.includes('attempts = attempts + 1')) {
      const [, maxAttempts, id] = vals as [string, number, string];
      const w = windows.find((x) => x.id === id);
      if (w) {
        w.attempts += 1;
        w.lease_owner = null;
        w.lease_expires_at = null;
        w.status = w.attempts >= maxAttempts ? 'failed' : 'pending';
      }
      return [];
    }

    throw new Error(`makeFakeDb: unrecognized query: ${text}`);
  });
}

/** A fake invoker: `extract` calls echo a deterministic summary derived from the prompt, and count invocations by task. */
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
        text = `<title>composed title</title>\n<summary>composed summary (${prompt.length} chars in)</summary>`;
      } else if (req.task === 'sessions.outline.window') {
        text = `window summary covering: ${prompt.slice(-40).replace(/\n/g, ' ')}`;
      } else if (req.task === 'sessions.outline.rollup') {
        text = `chapter summary covering: ${prompt.slice(-40).replace(/\n/g, ' ')}`;
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
      throw new Error('not used in these tests');
    },
    modelFor: () => 'test-extract-model',
    async spend() {
      throw new Error('not used in these tests');
    },
  };
  return { invoker, callsByTask, lastPromptByTask };
}

function baseSession(over: Partial<FakeSession> = {}): FakeSession {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    project_path: '/repo/thing',
    git_branch: 'main',
    content: bigTranscript(4),
    transcript_hash: 'hashA',
    outline: null,
    title: null,
    outline_hash: null,
    outline_attempts: 0,
    message_count: 4,
    outline_windows_hash: null,
    output_tokens: '100',
    started_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

// ── The windowing decision ──────────────────────────────────────────────────

describe('OutlineService — windowing decision', () => {
  it('a short session (few messages, small transcript) takes the single-pass path', async () => {
    const sessions = [baseSession({ message_count: 4 })];
    const { invoker, callsByTask } = makeFakeInvoker();
    const svc = new OutlineService(makeFakeDb(sessions, []), makeLogger(), { invoker });

    await svc.generateOutlinesSync();

    expect(callsByTask['sessions.outline']).toBe(1);
    expect(callsByTask['sessions.outline.window']).toBeUndefined();
    expect(callsByTask['sessions.outline.compose']).toBeUndefined();
    expect(sessions[0]!.outline).toBe('short summary');
    expect(sessions[0]!.title).toBe('short title');
    expect(sessions[0]!.outline_hash).toBe('hashA');
  });

  it('a session over the message-count threshold takes the windowed path', async () => {
    const sessions = [baseSession({ message_count: 500, content: bigTranscript(500) })];
    const { invoker, callsByTask } = makeFakeInvoker();
    const svc = new OutlineService(makeFakeDb(sessions, []), makeLogger(), {
      invoker,
      windowConfig: { thresholdMessages: 400, maxMessages: 100, sweepCap: 1000 },
    });

    await svc.generateOutlinesSync();

    expect(callsByTask['sessions.outline']).toBeUndefined();
    expect(callsByTask['sessions.outline.window']).toBeGreaterThan(0);
    expect(callsByTask['sessions.outline.compose']).toBe(1);
  });
});

// ── Windowed generation: boundaries, idempotency, composition ──────────────

describe('OutlineService — windowed generation', () => {
  it('carves and summarizes within the sweep cap, reading only what the sweep can use, and catches up over sweeps', async () => {
    const sessions = [baseSession({ message_count: 500, content: bigTranscript(500) })];
    const windows: FakeWindow[] = [];
    const { invoker, callsByTask } = makeFakeInvoker();
    const svc = new OutlineService(makeFakeDb(sessions, windows), makeLogger(), {
      invoker,
      windowConfig: { thresholdMessages: 400, maxMessages: 100, sweepCap: 2 }, // cap=2 x 100 msgs: each sweep reads at most 200 messages
    });

    const spy = spyOn(TranscriptReader.prototype, 'messagesSince');
    try {
      await svc.generateOutlinesSync();

      // Sweep 1 reads 200 of 500 messages: two closed windows, both summarized,
      // and no open tail recorded (the read was truncated, so its last segment
      // is not the session's real tail).
      expect(spy.mock.calls[0]?.[2]).toBe(200);
      expect(windows).toHaveLength(2);
      expect(windows.every((w) => w.closed_at !== null && w.summary !== null)).toBe(true);
      expect(callsByTask['sessions.outline.window']).toBe(2);
      // Not caught up: outline_hash must not advance, so the next sweep re-selects it.
      expect(sessions[0]!.outline_hash).toBeNull();
      expect(callsByTask['sessions.outline.compose']).toBe(1);
      expect(sessions[0]!.outline).toContain('composed summary');

      for (let i = 0; i < 6 && sessions[0]!.outline_hash !== 'hashA'; i++) {
        await svc.generateOutlinesSync();
      }
      expect(sessions[0]!.outline_hash).toBe('hashA');
      expect(windows.every((w) => w.summary !== null)).toBe(true);
      // Every window summarized exactly once, and they tile seqs 0..499 with no gaps.
      const sorted = [...windows].sort((a, b) => a.from_seq - b.from_seq);
      expect(sorted[0]!.from_seq).toBe(0);
      expect(sorted.at(-1)!.to_seq).toBe(499);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.from_seq).toBe(sorted[i - 1]!.to_seq + 1);
      // No read ever asked for more than the sweep's cap.
      expect(spy.mock.calls.every((c) => c[2] === 200)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('each sweep reads a bounded range starting from the earliest seq still needed', async () => {
    const sessions = [baseSession({ message_count: 500, content: bigTranscript(500) })];
    const windows: FakeWindow[] = [];
    const { invoker } = makeFakeInvoker();
    const svc = new OutlineService(makeFakeDb(sessions, windows), makeLogger(), {
      invoker,
      windowConfig: { thresholdMessages: 400, maxMessages: 100, sweepCap: 2 },
    });

    const spy = spyOn(TranscriptReader.prototype, 'messagesSince');
    try {
      await svc.generateOutlinesSync();
      await svc.generateOutlinesSync();
      await svc.generateOutlinesSync();
      // afterSeq advances by what each sweep consumed; it never restarts at -1.
      expect(spy.mock.calls.map((c) => c[1])).toEqual([-1, 199, 399]);
    } finally {
      spy.mockRestore();
    }
  });

  it('once the sweep budget is spent, remaining windowed sessions are not read at all', async () => {
    const sessions = [
      baseSession({ id: 'aaaaaaaa-0000-4000-8000-000000000001', message_count: 500, content: bigTranscript(500), started_at: '2026-01-02T00:00:00.000Z' }),
      baseSession({ id: 'aaaaaaaa-0000-4000-8000-000000000002', message_count: 500, content: bigTranscript(500), started_at: '2026-01-01T00:00:00.000Z' }),
    ];
    const windows: FakeWindow[] = [];
    const { invoker } = makeFakeInvoker();
    const svc = new OutlineService(makeFakeDb(sessions, windows), makeLogger(), {
      invoker,
      windowConfig: { thresholdMessages: 400, maxMessages: 100, sweepCap: 2 },
    });

    const spy = spyOn(TranscriptReader.prototype, 'messagesSince');
    try {
      await svc.generateOutlinesSync();
      // The first (newest) session spends the whole budget in one read; the
      // second is never read.
      expect(spy.mock.calls.map((c) => c[0])).toEqual([sessions[0]!.id]);
      expect(windows.every((w) => w.session_id === sessions[0]!.id)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('a closed window is summarized exactly once — fully caught up, the session drops out of the sweep entirely', async () => {
    const sessions = [baseSession({ message_count: 500, content: bigTranscript(500) })];
    const windows: FakeWindow[] = [];
    const { invoker, callsByTask } = makeFakeInvoker();
    const svc = new OutlineService(makeFakeDb(sessions, windows), makeLogger(), {
      invoker,
      windowConfig: { thresholdMessages: 400, maxMessages: 100, sweepCap: 1000 },
    });

    await svc.generateOutlinesSync();
    expect(sessions[0]!.outline_hash).toBe('hashA'); // fully caught up in one sweep
    const closedWindows = windows.filter((w) => w.closed_at !== null);
    expect(closedWindows.length).toBeGreaterThan(0);
    const windowCallsAfterFirstSweep = callsByTask['sessions.outline.window'];

    // Nothing changed: outline_hash now equals transcript_hash, so the
    // unforced sweep query no longer selects this session at all — the
    // strongest form of "summarized exactly once."
    const second = await svc.generateOutlinesSync();
    expect(second.sessionsProcessed).toBe(0);
    expect(callsByTask['sessions.outline.window']).toBe(windowCallsAfterFirstSweep);
  });

  it('composition is skipped when nothing changed (grew but no window closed and tail unchanged)', async () => {
    // A session just under one window's worth of messages: only ever an open
    // tail, never closes, and re-running with no new messages should not
    // re-summarize the tail or recompose.
    const sessions = [baseSession({ message_count: 450, content: bigTranscript(450) })];
    const windows: FakeWindow[] = [];
    const { invoker, callsByTask } = makeFakeInvoker();
    const svc = new OutlineService(makeFakeDb(sessions, windows), makeLogger(), {
      invoker,
      windowConfig: { thresholdMessages: 400, maxMessages: 1000, sweepCap: 1000 }, // never closes a window
    });

    await svc.generateOutlinesSync();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.closed_at).toBeNull();
    expect(callsByTask['sessions.outline.window']).toBe(1);
    expect(callsByTask['sessions.outline.compose']).toBe(1);
    expect(sessions[0]!.outline_hash).toBe('hashA');

    // Force reselection without actually changing the transcript (stands in
    // for a sweep re-running before the row's hash caught up elsewhere) — the
    // tail's content hasn't changed, so this must not re-invoke the model.
    const session = sessions[0]!;
    const hashOf = (): string | null => session.outline_hash;
    session.outline_hash = null;
    await svc.generateOutlinesSync();
    expect(callsByTask['sessions.outline.window']).toBe(1); // unchanged tail content -> skipped
    expect(callsByTask['sessions.outline.compose']).toBe(1); // signature unchanged -> not recomposed
    expect(hashOf()).toBe('hashA'); // re-caught-up
  });

  it('an empty session (no assistant output) is written as null without a model call, windowed or not', async () => {
    const sessions = [baseSession({ message_count: 4, output_tokens: '0' })];
    const { invoker, callsByTask } = makeFakeInvoker();
    const svc = new OutlineService(makeFakeDb(sessions, []), makeLogger(), { invoker });

    await svc.generateOutlinesSync();

    expect(Object.keys(callsByTask)).toHaveLength(0);
    expect(sessions[0]!.outline).toBeNull();
    expect(sessions[0]!.title).toBeNull();
    expect(sessions[0]!.outline_hash).toBe('hashA');
  });
});

// ── Rollups: chapter hierarchy on top of windows ────────────────────────────

describe('OutlineService — rollups', () => {
  it('forms and summarizes chapters across sweeps, sharing the window budget, each summarized exactly once, and eventually catches up', async () => {
    // 800 messages / maxMessages=100 -> 8 windows; rollupFanin=4 -> exactly
    // 2 level-1 chapters (8/4), too few (2 < 4) to ever climb to level 2.
    // sweepCap=3 forces this across several sweeps and makes windows and
    // rollups compete for the same shared budget within a sweep.
    const sessions = [baseSession({ message_count: 800, content: bigTranscript(800) })];
    const windows: FakeWindow[] = [];
    const rollups: FakeRollup[] = [];
    const { invoker, callsByTask } = makeFakeInvoker();
    const svc = new OutlineService(makeFakeDb(sessions, windows, undefined, rollups), makeLogger(), {
      invoker,
      windowConfig: { thresholdMessages: 400, maxMessages: 100, sweepCap: 3, rollupFanin: 4 },
    });

    for (let i = 0; i < 20 && sessions[0]!.outline_hash !== 'hashA'; i++) {
      await svc.generateOutlinesSync();
    }

    expect(sessions[0]!.outline_hash).toBe('hashA'); // fully caught up
    expect(windows).toHaveLength(8);
    expect(windows.every((w) => w.status === 'summarized')).toBe(true);
    expect(rollups).toHaveLength(2);
    expect(rollups.every((r) => r.status === 'summarized')).toBe(true);
    // Exactly once each — the model was never asked twice for the same window or rollup.
    expect(callsByTask['sessions.outline.window']).toBe(8);
    expect(callsByTask['sessions.outline.rollup']).toBe(2);
    expect(sessions[0]!.outline).toContain('composed summary');

    // Fully caught up: the unforced sweep query no longer selects this
    // session, so a further sweep must not touch the model again at all.
    const callsBefore = { ...callsByTask };
    const next = await svc.generateOutlinesSync();
    expect(next.sessionsProcessed).toBe(0);
    expect(callsByTask).toEqual(callsBefore);
  });

  it('does not compose while any rollup is still pending, so an outline never loses the content of unsummarized chapters', async () => {
    // 8 windows, fanin 4 -> 2 chapters. sweepCap 9 = all 8 windows + only 1
    // chapter in the first sweep, leaving the second chapter pending.
    const sessions = [baseSession({ message_count: 800, content: bigTranscript(800) })];
    const windows: FakeWindow[] = [];
    const rollups: FakeRollup[] = [];
    const { invoker, callsByTask } = makeFakeInvoker();
    const svc = new OutlineService(makeFakeDb(sessions, windows, undefined, rollups), makeLogger(), {
      invoker,
      windowConfig: { thresholdMessages: 400, maxMessages: 100, sweepCap: 9, rollupFanin: 4 },
    });
    const outlineBefore = sessions[0]!.outline;

    await svc.generateOutlinesSync();
    expect(rollups).toHaveLength(2);
    expect(rollups.filter((r) => r.status === 'summarized')).toHaveLength(1);
    expect(callsByTask['sessions.outline.compose'] ?? 0).toBe(0);
    expect(sessions[0]!.outline).toBe(outlineBefore);

    await svc.generateOutlinesSync();
    expect(rollups.every((r) => r.status === 'summarized')).toBe(true);
    expect(callsByTask['sessions.outline.compose']).toBe(1);
  });

  it('a level-1 chapter stands in for its windows in the compose call once summarized', async () => {
    const sessions = [baseSession({ message_count: 800, content: bigTranscript(800) })];
    const windows: FakeWindow[] = [];
    const rollups: FakeRollup[] = [];
    const { invoker, lastPromptByTask } = makeFakeInvoker();
    const svc = new OutlineService(makeFakeDb(sessions, windows, undefined, rollups), makeLogger(), {
      invoker,
      windowConfig: { thresholdMessages: 400, maxMessages: 100, sweepCap: 1000, rollupFanin: 4 }, // one sweep is enough
    });

    await svc.generateOutlinesSync();

    expect(sessions[0]!.outline_hash).toBe('hashA');
    expect(rollups).toHaveLength(2);
    const composePrompt = lastPromptByTask['sessions.outline.compose']!;
    expect(composePrompt).toContain('<chapter level="1" index="0"');
    expect(composePrompt).toContain('<chapter level="1" index="1"');
    // The chapters cover every window, so no individual <window> tag should
    // appear in the final compose call.
    expect(composePrompt).not.toContain('<window ');
  });

  it('a session too small to fill one fan-in group never grows a rollup, windowed or not', async () => {
    const sessions = [baseSession({ message_count: 500, content: bigTranscript(500) })];
    const windows: FakeWindow[] = [];
    const rollups: FakeRollup[] = [];
    const { invoker, callsByTask } = makeFakeInvoker();
    const svc = new OutlineService(makeFakeDb(sessions, windows, undefined, rollups), makeLogger(), {
      invoker,
      // maxMessages=200 -> 3 windows (200, 200, 100); rollupFanin defaults to 40, far above 3.
      windowConfig: { thresholdMessages: 400, maxMessages: 200, sweepCap: 1000 },
    });

    await svc.generateOutlinesSync();

    expect(rollups).toHaveLength(0);
    expect(callsByTask['sessions.outline.rollup']).toBeUndefined();
    expect(sessions[0]!.outline_hash).toBe('hashA');
  });

  it('a rollup that fails is retried up to the attempt cap, then goes terminal and is dropped from compose', async () => {
    const sessions = [baseSession({ message_count: 800, content: bigTranscript(800) })];
    const windows: FakeWindow[] = [];
    const rollups: FakeRollup[] = [];
    const { invoker } = makeFakeInvoker();
    let rollupCalls = 0;
    const failingInvoker: ModelInvoker = {
      ...invoker,
      async invoke(req) {
        if (req.task === 'sessions.outline.rollup') {
          rollupCalls++;
          throw new Error('model unavailable');
        }
        return invoker.invoke(req);
      },
    };
    const svc = new OutlineService(makeFakeDb(sessions, windows, undefined, rollups), makeLogger(), {
      invoker: failingInvoker,
      windowConfig: { thresholdMessages: 400, maxMessages: 100, sweepCap: 1000, rollupFanin: 4, maxAttempts: 3 },
    });

    for (let i = 0; i < 6; i++) {
      await svc.generateOutlinesSync();
    }

    expect(rollups).toHaveLength(2);
    expect(rollups.every((r) => r.status === 'failed')).toBe(true);
    expect(rollups.every((r) => r.attempts === 3)).toBe(true);
    // Exhausted the cap - no further attempts even after more sweeps, and the
    // session still reaches "caught up" (a permanently failed unit doesn't
    // block the sweep forever - same precedent as a permanently failed window).
    const callsAtCap = rollupCalls;
    await svc.generateOutlinesSync();
    expect(rollupCalls).toBe(callsAtCap);
    expect(sessions[0]!.outline_hash).toBe('hashA');
    // Both chapters failed with no summary, and every window is covered by
    // one of them - so, same as a session where every window fails, there is
    // no content left to compose and the outline stays unset. This matches
    // existing pre-rollup behavior (an all-failed windows-only session also
    // never gets composed) rather than being new rollup-specific fallout.
    expect(sessions[0]!.outline).toBeNull();
  });
});
