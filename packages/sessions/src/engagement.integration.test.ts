/**
 * Integration tests against a real, throwaway Postgres for session engagement
 * (specs/behaviors/session-engagement.md) — prompt events at ingest, the
 * backfill and its activity-range rebuild, and `GET /sessions/engagement`.
 * Self-skips unless SESSIONS_TEST_DATABASE_URL is set; setup is the same as
 * timeline.integration.test.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { SyncService } from './sync.js';
import { TranscriptReader } from './transcript-reader.js';
import { registerRoutes } from './routes.js';
import { runPromptBackfillCycle } from './prompt-backfill.js';
import { compileAutomatedPromptPatterns } from './prompt-classifier.js';
import { feed, EMPTY_CHECKPOINT } from './incremental-parser.js';

const DB_URL = process.env.SESSIONS_TEST_DATABASE_URL;
const maybeDescribe = DB_URL ? describe : describe.skip;

if (!DB_URL) {
  // eslint-disable-next-line no-console
  console.log('SESSIONS_TEST_DATABASE_URL not set — skipping engagement integration tests.');
}

function userLine(text: string, ts: string, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      type: 'user',
      uuid: crypto.randomUUID(),
      parentUuid: null,
      timestamp: ts,
      message: { role: 'user', content: text },
      ...extra,
    }) + '\n'
  );
}

const LOOP = '<command-message>loop</command-message>\n<command-name>/loop</command-name>';
const NOTIFY = '<task-notification>\n<task-id>abc</task-id>\n</task-notification>';

const noopLog = {
  info: () => {},
  warn: () => {},
  error: (...args: unknown[]) => console.error(...args),
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLog,
} as unknown as import('fastify').FastifyBaseLogger;

maybeDescribe('session engagement — integration (real Postgres)', () => {
  const sql = postgres(DB_URL ?? '');
  let dir: string;
  let app: FastifyInstance | null = null;
  const createdSessionIds: string[] = [];
  const createdMachineIds = new Set<string>();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ca-engagement-it-'));
  });

  afterEach(async () => {
    if (app) await app.close();
    app = null;
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

  function newSync(machine: string, opts: { chunkMaxBytes?: number } = {}): SyncService {
    createdMachineIds.add(machine);
    return new SyncService(sql, noopLog, { claudeDir: dir, machineId: machine, minFileSize: 1, ...opts });
  }

  /** Create a transcript file under its own project dir; returns its id + path. */
  async function newSession(project: string, content: string): Promise<{ id: string; path: string }> {
    const projectDir = join(dir, 'projects', project);
    await Bun.$`mkdir -p ${projectDir}`.quiet();
    const id = crypto.randomUUID();
    const path = join(projectDir, `${id}.jsonl`);
    await writeFile(path, content);
    createdSessionIds.push(id);
    return { id, path };
  }

  async function promptEvents(sessionId: string) {
    return sql<
      { seq: number; ts: Date | null; head: string; is_meta: boolean; is_sidechain: boolean; is_compact_summary: boolean; queued: boolean }[]
    >`
      SELECT seq, ts, head, is_meta, is_sidechain, is_compact_summary, queued
      FROM sessions.prompt_events WHERE session_id = ${sessionId}::uuid ORDER BY seq
    `;
  }

  async function sessionRow(sessionId: string) {
    const [row] = await sql`SELECT * FROM sessions.sessions WHERE id = ${sessionId}::uuid`;
    if (!row) throw new Error(`session ${sessionId} not found`);
    return row;
  }

  /** Put a session into the state migration 021 leaves pre-existing rows in. */
  async function markPreExisting(sessionId: string): Promise<void> {
    await sql`DELETE FROM sessions.prompt_events WHERE session_id = ${sessionId}::uuid`;
    await sql`
      UPDATE sessions.sessions SET
        prompt_backfill_done = false,
        prompt_backfill_next_chunk_seq = 0,
        prompt_backfill_checkpoint = NULL
      WHERE id = ${sessionId}::uuid
    `;
  }

  async function drainBackfill(sessionId: string, budget = 350): Promise<number> {
    let runs = 0;
    while (runs < 300) {
      await runPromptBackfillCycle(sql, budget);
      runs++;
      if ((await sessionRow(sessionId)).prompt_backfill_done) break;
    }
    return runs;
  }

  async function buildApp(opts: { ownerTz?: string; patterns?: string } = {}): Promise<FastifyInstance> {
    app = Fastify({ logger: false });
    app.decorate('sql', sql as any);
    await app.register(registerRoutes, {
      syncService: newSync('it-eng-routes'),
      outlineService: null,
      reader: new TranscriptReader(sql),
      ownerTz: opts.ownerTz,
      automatedPromptPatterns: compileAutomatedPromptPatterns(opts.patterns),
    });
    await app.ready();
    return app;
  }

  const get = async (a: FastifyInstance, query: Record<string, string>) =>
    a.inject({ method: 'GET', url: '/sessions/engagement', query });

  it('live ingest records one prompt event per user turn, with the transcript flags, append-only', async () => {
    const sync = newSync('it-eng-live');
    const { id, path } = await newSession(
      '-live',
      userLine('  please fix the build', '2025-03-03T15:00:00Z') +
        userLine('Base directory for this skill: /x', '2025-03-03T15:00:01Z', { isMeta: true }) +
        userLine('subagent brief', '2025-03-03T15:00:02Z', { isSidechain: true }) +
        userLine('This session is being continued', '2025-03-03T15:00:03Z', { isCompactSummary: true }) +
        JSON.stringify({
          type: 'attachment',
          uuid: crypto.randomUUID(),
          timestamp: '2025-03-03T15:00:04Z',
          attachment: { type: 'queued_command', prompt: 'also bump the version' },
        }) +
        '\n' +
        userLine('x'.repeat(1000), '2025-03-03T15:00:05Z')
    );
    await sync.syncLocal();

    expect((await sessionRow(id)).prompt_backfill_done).toBe(true); // brand-new: no backlog
    const events = await promptEvents(id);
    expect(events.map((e) => [e.seq, e.is_meta, e.is_sidechain, e.is_compact_summary, e.queued])).toEqual([
      [0, false, false, false, false],
      [1, true, false, false, false],
      [2, false, true, false, false],
      [3, false, false, true, false],
      [4, false, false, false, true],
      [5, false, false, false, false],
    ]);
    expect(events[0]!.head).toBe('please fix the build'); // front-trimmed
    expect(events[4]!.head).toBe('also bump the version');
    expect(events[5]!.head).toHaveLength(256); // bounded

    const before = await sql<{ id: string; seq: number }[]>`
      SELECT id, seq FROM sessions.prompt_events WHERE session_id = ${id}::uuid ORDER BY seq
    `;
    await appendFile(path, userLine('one more', '2025-03-03T15:10:00Z'));
    await sync.syncLocal();
    const after = await sql<{ id: string; seq: number }[]>`
      SELECT id, seq FROM sessions.prompt_events WHERE session_id = ${id}::uuid ORDER BY seq
    `;
    expect(after).toHaveLength(7);
    expect(after.slice(0, 6)).toEqual(before); // earlier rows untouched, not rewritten

    // A rewrite (continuity failure) replaces them rather than accumulating.
    await writeFile(path, userLine('fresh start', '2025-03-03T16:00:00Z'));
    await sync.syncLocal();
    expect((await promptEvents(id)).map((e) => e.head)).toEqual(['fresh start']);
  });

  it('backfill derives prompt events for a pre-existing multi-chunk session and repairs inverted ranges', async () => {
    const sync = newSync('it-eng-backfill', { chunkMaxBytes: 300 });
    const base = Date.parse('2025-04-01T12:00:00Z');
    let content = '';
    // Two bursts, three hours apart.
    for (let i = 0; i < 20; i++) content += userLine(`turn ${i}`, new Date(base + i * 60_000).toISOString());
    for (let i = 0; i < 20; i++) content += userLine(`later ${i}`, new Date(base + 3 * 3_600_000 + i * 60_000).toISOString());
    const { id, path } = await newSession('-backfill', content);
    await sync.syncLocal();

    const chunks = await sql`SELECT seq FROM sessions.transcript_chunks WHERE session_id = ${id}::uuid`;
    expect(chunks.length).toBeGreaterThan(5);

    // Pre-existing, with ranges as the pre-monotone merge could leave them:
    // the last range's end pulled weeks behind its start.
    await markPreExisting(id);
    const inverted = [
      { start: new Date(base).toISOString(), end: new Date(base + 19 * 60_000).toISOString() },
      { start: new Date(base + 3 * 3_600_000).toISOString(), end: '2025-03-01T00:00:00.000Z' },
    ];
    await sql`
      UPDATE sessions.sessions SET
        activity_ranges = ${sql.json(inverted)},
        parse_checkpoint = jsonb_set(parse_checkpoint, '{lastActivityEnd}', '"2025-03-01T00:00:00.000Z"')
      WHERE id = ${id}::uuid
    `;

    // While pending, the activity feed withholds the inverted range rather
    // than returning end < start, and engagement reports the gap in coverage.
    const a = await buildApp({ ownerTz: 'UTC' });
    const activity = (await a.inject({ method: 'GET', url: '/sessions/activity', query: { days: '100000' } })).json() as any[];
    for (const s of activity) for (const r of s.activity_ranges) expect(r.duration_minutes).toBeGreaterThanOrEqual(0);
    const pendingBody = (await get(a, { from: '2025-04-01', to: '2025-04-01' })).json() as any;
    expect(pendingBody.pending_sessions).toBe(1);
    expect(pendingBody.days[0].envelope_minutes).toBe(0);

    const runs = await drainBackfill(id);
    expect(runs).toBeGreaterThan(1);

    const { delta: oracle } = feed(
      EMPTY_CHECKPOINT,
      content.split('\n').filter((l) => l.length > 0).map((l) => l + '\n')
    );
    const events = await promptEvents(id);
    expect(events.map((e) => [e.seq, e.head, e.ts?.toISOString()])).toEqual(
      oracle.promptEvents.map((e) => [e.seq, e.head, e.ts?.toISOString()])
    );

    const expected = [
      { start: new Date(base).toISOString(), end: new Date(base + 19 * 60_000).toISOString() },
      {
        start: new Date(base + 3 * 3_600_000).toISOString(),
        end: new Date(base + 3 * 3_600_000 + 19 * 60_000).toISOString(),
      },
    ];
    let row = await sessionRow(id);
    expect(row.activity_ranges).toEqual(expected);
    expect(row.parse_checkpoint.lastActivityEnd).toBe(expected[1]!.end);
    // Issue #259 item 4: the last prompt event reaches the transcript's last turn.
    expect(events[events.length - 1]!.ts!.getTime()).toBe(new Date(row.ended_at).getTime());

    // Handoff: live ingest now writes the new turn's event itself, extends
    // the repaired range, and duplicates nothing.
    await appendFile(path, userLine('after backfill', new Date(base + 3 * 3_600_000 + 25 * 60_000).toISOString()));
    await sync.syncLocal();
    const finalEvents = await promptEvents(id);
    expect(finalEvents).toHaveLength(41);
    expect(new Set(finalEvents.map((e) => e.seq)).size).toBe(41);
    row = await sessionRow(id);
    expect(row.activity_ranges).toEqual([
      expected[0]!,
      { start: expected[1]!.start, end: new Date(base + 3 * 3_600_000 + 25 * 60_000).toISOString() },
    ]);

    expect(((await get(a, { from: '2025-04-01', to: '2025-04-01' })).json() as any).pending_sessions).toBe(0);
  });

  it('an append made while the backfill is mid-flight is covered once, by the backfill', async () => {
    const sync = newSync('it-eng-race', { chunkMaxBytes: 300 });
    const base = Date.parse('2025-05-01T12:00:00Z');
    let content = '';
    for (let i = 0; i < 20; i++) content += userLine(`turn ${i}`, new Date(base + i * 60_000).toISOString());
    const { id, path } = await newSession('-race', content);
    await sync.syncLocal();

    await markPreExisting(id);
    await runPromptBackfillCycle(sql, 350); // partial progress only
    expect((await sessionRow(id)).prompt_backfill_done).toBe(false);
    const partial = (await promptEvents(id)).length;
    expect(partial).toBeLessThan(20);

    // Live ingest runs now: it must not write its own events yet.
    await appendFile(path, userLine('turn 20', new Date(base + 20 * 60_000).toISOString()));
    await sync.syncLocal();
    expect(await promptEvents(id)).toHaveLength(partial);

    await drainBackfill(id);
    const events = await promptEvents(id);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 21 }, (_, i) => i));
    expect((await sessionRow(id)).activity_ranges).toEqual([
      { start: new Date(base).toISOString(), end: new Date(base + 20 * 60_000).toISOString() },
    ]);
  });

  it('GET /sessions/engagement: human-only, pooled across sessions, bucketed by local day', async () => {
    const sync = newSync('it-eng-endpoint');
    // Two parallel sessions in one project, prompted alternately across one
    // hour (14:00–14:50Z = 10:00–10:50 in New York, EDT).
    const a1 = await newSession(
      '-home-u-repos-site',
      [0, 20, 40].map((m) => userLine(`a ${m}`, `2025-06-10T14:${String(m).padStart(2, '0')}:00Z`, { cwd: '/home/u/repos/site' })).join('')
    );
    const a2 = await newSession(
      '-home-u-repos-site',
      [10, 30, 50].map((m) => userLine(`b ${m}`, `2025-06-10T14:${String(m).padStart(2, '0')}:00Z`, { cwd: '/home/u/repos/site' })).join('')
    );
    // A bot loop firing every 20 minutes around the clock, plus notifications
    // and one scheduled instance command.
    let botContent = '';
    for (let m = 0; m < 24 * 60; m += 20) {
      const ts = new Date(Date.parse('2025-06-10T04:00:00Z') + m * 60_000).toISOString();
      botContent += userLine(m % 60 === 0 ? NOTIFY : LOOP, ts, { cwd: '/home/u/bot' });
    }
    botContent += userLine('<command-name>/EXAMPLE_sync</command-name>', '2025-06-10T20:07:00Z', { cwd: '/home/u/bot' });
    const bot = await newSession('-home-u-bot', botContent);
    // One prompt at 23:50 local (03:50Z next day) — crosses local midnight.
    const late = await newSession('-home-u-repos-api', userLine('late fix', '2025-06-11T03:50:00Z', { cwd: '/home/u/repos/api' }));
    await sync.syncLocal();

    const a = await buildApp({ ownerTz: 'America/New_York', patterns: '^<command-name>/EXAMPLE_sync' });
    const res = await get(a, { from: '2025-06-10', to: '2025-06-11' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body).toMatchObject({
      from: '2025-06-10',
      to: '2025-06-11',
      tz: 'America/New_York', // resolved from the owner zone, echoed
      block_minutes: 15,
      gap_minutes: 15,
      pending_sessions: 0,
    });
    expect(body.days.map((d: any) => d.date)).toEqual(['2025-06-10', '2025-06-11']);

    const [d10, d11] = body.days;
    // The interleaved hour counts once (65 min), plus 10 min before midnight.
    expect(d10.envelope_minutes).toBe(65 + 10);
    expect(d10.human_prompt_count).toBe(7);
    expect(d10.first_human_prompt).toBe('2025-06-10T14:00:00.000Z');
    expect(d10.last_human_prompt).toBe('2025-06-11T03:50:00.000Z');
    expect(d10.projects.map((p: any) => [p.project_path, p.human_minutes, p.human_prompt_count])).toEqual([
      ['/home/u/repos/site', 65, 6],
      ['/home/u/repos/api', 10, 1],
    ]);
    expect(d10.projects[0].project_name).toBeTruthy();

    const byId = new Map<string, any>(d10.sessions.map((s: any) => [s.id, s]));
    expect(byId.get(a1.id).human_minutes).toBe(55);
    expect(byId.get(a2.id).human_minutes).toBe(55);
    // The bot ran all local day and a human never touched it.
    const botDay = byId.get(bot.id);
    expect(botDay.human_minutes).toBe(0);
    expect(botDay.human_prompt_count).toBe(0);
    expect(botDay.automated_minutes).toBe(24 * 60 - 5); // last firing 23:40 local, block to 23:55
    expect(botDay.automated_by).toEqual({ loop: 48, 'task-notification': 24, instance: 1 });
    expect(botDay.automated_prompt_count).toBe(73);

    // The 23:50 block's last five minutes land on the 11th.
    expect(d11.envelope_minutes).toBe(5);
    expect(d11.human_prompt_count).toBe(0);
    expect(d11.sessions.find((s: any) => s.id === late.id)).toMatchObject({ human_minutes: 5, human_prompt_count: 0 });

    // The same day from a different window returns the same figures.
    const narrow = (await get(a, { from: '2025-06-10', to: '2025-06-10' })).json() as any;
    expect(narrow.days[0]).toEqual(d10);

    // An explicit tz overrides the owner zone and moves the late prompt's day.
    const utc = (await get(a, { from: '2025-06-10', to: '2025-06-11', tz: 'UTC' })).json() as any;
    expect(utc.tz).toBe('UTC');
    expect(utc.days.map((d: any) => d.envelope_minutes)).toEqual([65, 15]);
  });

  it('a fork carrying its parent\'s turns counts them once, and its rebuilt ranges cover only its own', async () => {
    const sync = newSync('it-eng-fork', { chunkMaxBytes: 300 });
    // Parent: 12:00–12:19 on the 1st, then stopped. Fork: the same twelve
    // lines verbatim (same uuid, same timestamp), then its own turns a day
    // later. Both files therefore have the same started_at.
    const sharedLines: string[] = [];
    for (let i = 0; i < 20; i++) sharedLines.push(userLine(`turn ${i}`, `2025-08-01T12:${String(i).padStart(2, '0')}:00Z`));
    const parent = await newSession('-fork', sharedLines.join(''));
    let forkContent = sharedLines.join('');
    // The parent's own history replayed once more within the fork, as a
    // resume does, then the fork's new turns.
    forkContent += sharedLines[5]!;
    for (let i = 0; i < 10; i++) forkContent += userLine(`fork ${i}`, `2025-08-02T15:${String(i).padStart(2, '0')}:00Z`);
    const fork = await newSession('-fork', forkContent);
    await sync.syncLocal();

    const a = await buildApp({ ownerTz: 'UTC' });
    const body = (await get(a, { from: '2025-08-01', to: '2025-08-02' })).json() as any;
    const [d1, d2] = body.days;
    expect(d1.human_prompt_count).toBe(20); // not 41
    expect(d1.envelope_minutes).toBe(34);
    expect(d1.sessions.map((s: any) => s.id)).toEqual([parent.id]); // the fork did not exist yet
    expect(d1.sessions[0]).toMatchObject({ human_prompt_count: 20, human_minutes: 34 });
    expect(d2.sessions.map((s: any) => [s.id, s.human_prompt_count, s.human_minutes])).toEqual([[fork.id, 10, 24]]);

    // Backfill both as pre-existing. Ownership order processes the parent
    // first; the fork's rebuilt ranges then exclude the replayed turns.
    await markPreExisting(parent.id);
    await markPreExisting(fork.id);
    const order: string[] = [];
    for (let i = 0; i < 400; i++) {
      await runPromptBackfillCycle(sql, 350);
      for (const id of [parent.id, fork.id]) {
        if (!order.includes(id) && (await sessionRow(id)).prompt_backfill_done) order.push(id);
      }
      if (order.length === 2) break;
    }
    expect(order).toEqual([parent.id, fork.id]);
    expect((await sessionRow(parent.id)).activity_ranges).toEqual([
      { start: '2025-08-01T12:00:00.000Z', end: '2025-08-01T12:19:00.000Z' },
    ]);
    expect((await sessionRow(fork.id)).activity_ranges).toEqual([
      { start: '2025-08-02T15:00:00.000Z', end: '2025-08-02T15:09:00.000Z' },
    ]);
  });

  it('a session of self-paced loop wakeups reports 0 human minutes; the same command typed is human', async () => {
    const sync = newSync('it-eng-wakeups');
    let content = '';
    for (let m = 0; m < 180; m += 20) {
      content += userLine(
        '<command-message>EXAMPLE-sync</command-message>\n<command-name>/EXAMPLE-sync</command-name>',
        new Date(Date.parse('2025-09-01T12:00:00Z') + m * 60_000).toISOString(),
        { queuePriority: 'later' }
      );
    }
    const bot = await newSession('-wakeups', content);
    // A person typing the same command, on a client that records authorship,
    // plus a `!` shell command: the input is the person, the output is not.
    const person = await newSession(
      '-typed',
      userLine('<command-message>EXAMPLE-sync</command-message>', '2025-09-01T18:00:00Z', {
        origin: { kind: 'human' },
        promptSource: 'typed',
      }) +
        userLine('<bash-input>git status</bash-input>', '2025-09-01T18:20:00Z') +
        userLine('<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>', '2025-09-01T18:20:01Z') +
        userLine('a task notification carrying a human source', '2025-09-01T18:40:00Z', {
          origin: { kind: 'task-notification' },
          promptSource: 'sdk',
        })
    );
    await sync.syncLocal();

    const a = await buildApp({ ownerTz: 'UTC' });
    const [d] = ((await get(a, { from: '2025-09-01', to: '2025-09-01' })).json() as any).days;
    const byId = new Map<string, any>(d.sessions.map((s: any) => [s.id, s]));
    expect(byId.get(bot.id)).toMatchObject({
      human_minutes: 0,
      human_prompt_count: 0,
      automated_prompt_count: 9,
      automated_by: { scheduled: 9 },
    });
    expect(byId.get(person.id)).toMatchObject({
      human_prompt_count: 2,
      human_minutes: 35,
      automated_by: { 'local-command': 1, 'task-notification': 1 },
    });
    expect(d.envelope_minutes).toBe(35);
  });

  it('an instance pattern reclassifies past days with no re-ingest', async () => {
    const sync = newSync('it-eng-pattern');
    await newSession(
      '-pattern',
      userLine('[bridge] message relayed from chat', '2025-07-01T12:00:00Z') + userLine('typed by hand', '2025-07-01T15:00:00Z')
    );
    await sync.syncLocal();

    const without = await buildApp({ ownerTz: 'UTC' });
    const before = (await get(without, { from: '2025-07-01', to: '2025-07-01' })).json() as any;
    expect(before.days[0].envelope_minutes).toBe(30);
    await without.close();

    const withPattern = await buildApp({ ownerTz: 'UTC', patterns: '^\\[bridge\\] ' });
    const after = (await get(withPattern, { from: '2025-07-01', to: '2025-07-01' })).json() as any;
    expect(after.days[0].envelope_minutes).toBe(15);
    expect(after.days[0].sessions[0].automated_by).toEqual({ instance: 1 });
  });

  it('rejects bad parameters with a 400 naming the parameter', async () => {
    const noZone = await buildApp();
    const expect400 = async (a: FastifyInstance, query: Record<string, string>, param: string) => {
      const res = await get(a, query);
      expect(res.statusCode).toBe(400);
      expect((res.json() as any).param).toBe(param);
      return res.json() as any;
    };
    const ok = { from: '2025-06-01', to: '2025-06-02', tz: 'UTC' };

    await expect400(noZone, { to: ok.to, tz: ok.tz }, 'from');
    await expect400(noZone, { ...ok, from: '2025-6-1' }, 'from');
    await expect400(noZone, { ...ok, to: '2025-02-30' }, 'to');
    await expect400(noZone, { ...ok, to: '2025-05-31' }, 'to');
    await expect400(noZone, { ...ok, tz: 'Mars/Olympus_Mons' }, 'tz');
    await expect400(noZone, { ...ok, block_minutes: '0' }, 'block_minutes');
    await expect400(noZone, { ...ok, block_minutes: 'abc' }, 'block_minutes');
    await expect400(noZone, { ...ok, gap_minutes: '-1' }, 'gap_minutes');
    // No tz and no owner zone: a 400, never the host's zone.
    await expect400(noZone, { from: ok.from, to: ok.to }, 'tz');

    // 93 days is over the cap; the body says so and by how much.
    const over = await expect400(noZone, { from: '2025-01-01', to: '2025-04-03', tz: 'UTC' }, 'to');
    expect(over).toMatchObject({ max_days: 92, requested_days: 93 });
    expect((await get(noZone, { from: '2025-01-01', to: '2025-04-02', tz: 'UTC' })).statusCode).toBe(200);
    expect((await get(noZone, { ...ok, gap_minutes: '0' })).statusCode).toBe(200);
  });
});
