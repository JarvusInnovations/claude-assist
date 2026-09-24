import { describe, expect, it, mock } from 'bun:test';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { ModelInvoker, InvokeRequest, InvokeResult } from '@jarvus/claude-assist-core';
import { OutlineService } from './outline.js';

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
  raw_transcript: string;
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

let nextWindowId = 1;

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
  seen?: { text: string; vals: unknown[] }[]
): postgres.Sql {
  return makeFakeSql(async (text, vals) => {
    seen?.push({ text, vals });
    // ── sweep selection ──
    if (text.includes('WHERE outline_hash IS DISTINCT FROM transcript_hash') && text.includes('ORDER BY started_at DESC')) {
      const cap = vals[0] as number;
      return sessions
        .filter((s) => s.outline_hash !== s.transcript_hash && s.outline_attempts < cap)
        .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
        .map((s) => ({ ...s }));
    }

    // ── TranscriptReader.readFull ──
    if (text.includes('SELECT raw_transcript FROM sessions.sessions')) {
      const [id] = vals as [string];
      const s = sessions.find((x) => x.id === id);
      if (!s) return [];
      return [{ raw_transcript: s.raw_transcript }];
    }

    // ── TranscriptReader.readHeadTail ──
    if (text.includes('full_length')) {
      const [budgetBytes, half, , id] = vals as [number, number, number, string];
      const s = sessions.find((x) => x.id === id);
      if (!s) return [];
      const content = s.raw_transcript;
      const fullLength = content.length;
      const raw = fullLength <= budgetBytes ? content : content.slice(0, half) + '\n' + content.slice(content.length - half);
      return [{ raw, full_length: fullLength }];
    }

    // ── TranscriptReader.rawByteLength ──
    if (text.includes('AS len')) {
      const [id] = vals as [string];
      const s = sessions.find((x) => x.id === id);
      return [{ len: s ? s.raw_transcript.length : 0 }];
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
function makeFakeInvoker(): { invoker: ModelInvoker; callsByTask: Record<string, number> } {
  const callsByTask: Record<string, number> = {};
  const invoker: ModelInvoker = {
    enabled: true,
    async invoke(req: InvokeRequest): Promise<InvokeResult> {
      callsByTask[req.task] = (callsByTask[req.task] ?? 0) + 1;
      const prompt = typeof req.messages[0]?.content === 'string' ? req.messages[0].content : '';
      let text: string;
      if (req.task === 'sessions.outline.compose') {
        text = `<title>composed title</title>\n<summary>composed summary (${prompt.length} chars in)</summary>`;
      } else if (req.task === 'sessions.outline.window') {
        text = `window summary covering: ${prompt.slice(-40).replace(/\n/g, ' ')}`;
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
  return { invoker, callsByTask };
}

function baseSession(over: Partial<FakeSession> = {}): FakeSession {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    project_path: '/repo/thing',
    git_branch: 'main',
    raw_transcript: bigTranscript(4),
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
    const sessions = [baseSession({ message_count: 500, raw_transcript: bigTranscript(500) })];
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
  it('carves windows, summarizes within the sweep cap, and leaves outline_hash stale until fully caught up', async () => {
    const sessions = [baseSession({ message_count: 500, raw_transcript: bigTranscript(500) })];
    const windows: FakeWindow[] = [];
    const { invoker, callsByTask } = makeFakeInvoker();
    const svc = new OutlineService(makeFakeDb(sessions, windows), makeLogger(), {
      invoker,
      windowConfig: { thresholdMessages: 400, maxMessages: 100, sweepCap: 2 }, // 500 msgs / 100 = 4 closed + 1 open tail; cap=2 forces a partial sweep
    });

    await svc.generateOutlinesSync();

    // 5 windows total (4 closed + 1 open tail), but only 2 summarized this sweep.
    expect(windows).toHaveLength(5);
    const summarizedCount = windows.filter((w) => w.summary !== null).length;
    expect(summarizedCount).toBe(2);
    expect(callsByTask['sessions.outline.window']).toBe(2);
    // Not fully caught up — outline_hash must NOT advance, so the next sweep re-selects it.
    expect(sessions[0]!.outline_hash).toBeNull();
    // Some summaries exist, so composition ran once over what's available so far.
    expect(callsByTask['sessions.outline.compose']).toBe(1);
    expect(sessions[0]!.outline).toContain('composed summary');

    // A second sweep with the same cap makes further progress and eventually catches up.
    await svc.generateOutlinesSync();
    await svc.generateOutlinesSync();
    expect(windows.every((w) => w.summary !== null)).toBe(true);
    expect(sessions[0]!.outline_hash).toBe('hashA');
  });

  it('once the sweep budget is spent, remaining windowed sessions are not read at all', async () => {
    const sessions = [
      baseSession({ id: 'aaaaaaaa-0000-4000-8000-000000000001', message_count: 500, raw_transcript: bigTranscript(500), started_at: '2026-01-02T00:00:00.000Z' }),
      baseSession({ id: 'aaaaaaaa-0000-4000-8000-000000000002', message_count: 500, raw_transcript: bigTranscript(500), started_at: '2026-01-01T00:00:00.000Z' }),
    ];
    const windows: FakeWindow[] = [];
    const seen: { text: string; vals: unknown[] }[] = [];
    const { invoker } = makeFakeInvoker();
    const svc = new OutlineService(makeFakeDb(sessions, windows, seen), makeLogger(), {
      invoker,
      windowConfig: { thresholdMessages: 400, maxMessages: 100, sweepCap: 2 },
    });

    await svc.generateOutlinesSync();

    const fullReads = seen.filter((q) => q.text.includes('SELECT raw_transcript FROM sessions.sessions'));
    // The first (newest) session spends the whole budget; it is parsed exactly
    // once despite having several windows, and the second is never read.
    expect(fullReads.map((q) => q.vals[0])).toEqual([sessions[0]!.id]);
    expect(windows.every((w) => w.session_id === sessions[0]!.id)).toBe(true);
  });

  it('a closed window is summarized exactly once — fully caught up, the session drops out of the sweep entirely', async () => {
    const sessions = [baseSession({ message_count: 500, raw_transcript: bigTranscript(500) })];
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
    const sessions = [baseSession({ message_count: 450, raw_transcript: bigTranscript(450) })];
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
