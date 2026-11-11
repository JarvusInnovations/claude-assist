import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HANDOFF_EVENT_KINDS,
  createHandoff,
  parseHandoffAuthors,
  parseHandoffEvents,
  selectHandoff,
  spawnRunner,
  type HandoffAuthors,
  type HandoffConfig,
  type HandoffRunner,
  type SlackEventLike,
} from './handoff.js';
import { createEventRouter } from './router.js';

const OWNER = 'UOWNER';
const OTHER = 'UOTHER';
const SELF = { botUserId: 'UBOT', botId: 'BBOT' };

function config(overrides: Partial<HandoffConfig> = {}): HandoffConfig {
  return {
    command: ['consumer'],
    events: [...HANDOFF_EVENT_KINDS],
    authors: 'owner',
    timeoutMs: 1000,
    ...overrides,
  };
}

function silentLog() {
  const errors: Array<Record<string, unknown>> = [];
  return {
    errors,
    log: {
      info: () => {},
      debug: () => {},
      error: (obj: Record<string, unknown>) => {
        errors.push(obj);
      },
    } as never,
  };
}

/** A runner that records each call's argv and parsed stdin. */
function recordingRunner(fail = false) {
  const calls: Array<{ command: string[]; payload: Record<string, unknown> }> = [];
  const runner: HandoffRunner = async (command, input) => {
    calls.push({ command, payload: JSON.parse(input) });
    if (fail) throw new Error('exited with 1');
  };
  return { calls, runner };
}

const ownerDm = {
  type: 'message',
  channel: 'DCHAN',
  channel_type: 'im',
  user: OWNER,
  ts: '1700000000.000100',
  text: 'hello',
  event_ts: '1700000000.000100',
};

const ownerMention = {
  type: 'app_mention',
  channel: 'CCHAN',
  user: OWNER,
  ts: '1700000001.000200',
  text: '<@UBOT> take a look',
  event_ts: '1700000001.000200',
  team: 'TTEAM',
};

/** Builds a router wired to a recording DM handler and an optional hand-off. */
function harness(opts: { handoff?: boolean; authors?: HandoffAuthors; fail?: boolean; runner?: HandoffRunner } = {}) {
  const dms: Array<Record<string, unknown>> = [];
  const rec = recordingRunner(opts.fail);
  const { log, errors } = silentLog();
  const handoff = opts.handoff
    ? createHandoff({
        config: config({ authors: opts.authors ?? 'owner' }),
        ownerUserId: OWNER,
        log,
        runner: opts.runner ?? rec.runner,
      })
    : null;
  const router = createEventRouter<Record<string, unknown>>({
    ownerUserId: OWNER,
    handoff,
    onDirectMessage: async (event) => {
      dms.push(event);
    },
  });
  return { router, handoff, dms, calls: rec.calls, errors };
}

describe('parseHandoffEvents', () => {
  it('defaults to every kind', () => {
    expect(parseHandoffEvents(undefined)).toEqual(['app_mention', 'message', 'reaction_added']);
    expect(parseHandoffEvents('  ')).toEqual(['app_mention', 'message', 'reaction_added']);
  });

  it('keeps known kinds and reports unknown ones', () => {
    const unknown: string[] = [];
    expect(parseHandoffEvents('app_mention, bogus,app_mention', (k) => unknown.push(k))).toEqual(['app_mention']);
    expect(unknown).toEqual(['bogus']);
  });
});

describe('parseHandoffAuthors', () => {
  it('defaults to owner and falls back to owner on an unknown value', () => {
    const unknown: string[] = [];
    expect(parseHandoffAuthors(undefined)).toBe('owner');
    expect(parseHandoffAuthors('any')).toBe('any');
    expect(parseHandoffAuthors('everyone', (v) => unknown.push(v))).toBe('owner');
    expect(unknown).toEqual(['everyone']);
  });
});

describe('selectHandoff', () => {
  const base = { ownerUserId: OWNER, self: SELF, envelope: { eventId: 'Ev1', teamId: 'TENV' } };

  it('builds the payload for an owner mention', () => {
    expect(selectHandoff('app_mention', ownerMention, { ...base, config: config() })).toEqual({
      type: 'app_mention',
      channel: 'CCHAN',
      channel_type: null,
      user: OWNER,
      ts: '1700000001.000200',
      thread_ts: null,
      text: '<@UBOT> take a look',
      event_ts: '1700000001.000200',
      team: 'TTEAM',
      is_owner: true,
      is_self: false,
      raw: ownerMention,
    });
  });

  it('hands off channel, private channel and group-DM messages, including thread replies', () => {
    for (const channel_type of ['channel', 'group', 'mpim']) {
      const event = { type: 'message', channel: 'C1', channel_type, user: OWNER, ts: '2.0', thread_ts: '1.0', text: 'x' };
      const payload = selectHandoff('message', event, { ...base, config: config() });
      expect(payload?.channel_type).toBe(channel_type);
      expect(payload?.thread_ts).toBe('1.0');
    }
  });

  it('never hands off a direct message', () => {
    expect(selectHandoff('message', ownerDm, { ...base, config: config({ authors: 'any' }) })).toBeNull();
  });

  it('skips edits, deletions and system subtypes', () => {
    for (const subtype of ['message_changed', 'message_deleted', 'channel_join']) {
      const event = { channel: 'C1', channel_type: 'channel', user: OWNER, ts: '1.0', subtype };
      expect(selectHandoff('message', event, { ...base, config: config() })).toBeNull();
    }
  });

  it('hands off the bot’s own posts under owner, flagged is_self', () => {
    const own = { channel: 'C1', channel_type: 'channel', user: 'UBOT', bot_id: 'BBOT', ts: '3.0', text: 'root' };
    const payload = selectHandoff('message', own, { ...base, config: config() });
    expect(payload?.is_self).toBe(true);
    expect(payload?.is_owner).toBe(false);
  });

  it('drops other bots under owner and keeps them under any', () => {
    const bot = { channel: 'C1', channel_type: 'channel', user: 'UOTHERBOT', bot_id: 'BOTHER', ts: '4.0', subtype: 'bot_message' };
    expect(selectHandoff('message', bot, { ...base, config: config() })).toBeNull();
    expect(selectHandoff('message', bot, { ...base, config: config({ authors: 'any' }) })?.is_self).toBe(false);
  });

  it('describes a reaction by the message reacted to, and skips the bot’s own reactions', () => {
    const reaction: SlackEventLike & { reaction: string } = {
      type: 'reaction_added',
      user: OWNER,
      reaction: 'eyes',
      item: { type: 'message', channel: 'C1', ts: '5.0', channel_type: 'channel' },
      event_ts: '6.0',
    };
    const payload = selectHandoff('reaction_added', reaction, { ...base, config: config() });
    expect(payload).toMatchObject({ channel: 'C1', channel_type: 'channel', ts: '5.0', text: null, thread_ts: null, team: 'TENV' });
    expect((payload?.raw as { reaction: string }).reaction).toBe('eyes');

    const own = { ...reaction, user: 'UBOT' };
    expect(selectHandoff('reaction_added', own, { ...base, config: config({ authors: 'any' }) })).toBeNull();
  });

  it('only hands off configured kinds', () => {
    expect(selectHandoff('app_mention', ownerMention, { ...base, config: config({ events: ['message'] }) })).toBeNull();
  });
});

describe('event routing with and without the hand-off', () => {
  for (const handoff of [false, true]) {
    it(`answers the owner's DM exactly as before (hand-off ${handoff ? 'on' : 'off'})`, async () => {
      const h = harness({ handoff });
      await h.router.message(ownerDm, { eventId: 'EvDM' }, SELF);
      expect(h.dms).toEqual([ownerDm]);
      expect(h.calls).toHaveLength(0);
    });

    it(`ignores non-owner, bot and edited DMs (hand-off ${handoff ? 'on' : 'off'})`, async () => {
      const h = harness({ handoff, authors: 'any' });
      await h.router.message({ ...ownerDm, user: OTHER }, { eventId: 'Ev1' }, SELF);
      await h.router.message({ ...ownerDm, user: 'UBOT', bot_id: 'BBOT' }, { eventId: 'Ev2' }, SELF);
      await h.router.message({ ...ownerDm, subtype: 'message_changed' }, { eventId: 'Ev3' }, SELF);
      expect(h.dms).toHaveLength(0);
      expect(h.calls).toHaveLength(0);
    });
  }

  it('hands off an owner mention with the right JSON and no agent run', async () => {
    const h = harness({ handoff: true });
    await h.router.appMention(ownerMention, { eventId: 'EvM1', teamId: 'TENV' }, SELF);
    expect(h.dms).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.command).toEqual(['consumer']);
    expect(h.calls[0]!.payload).toEqual({
      type: 'app_mention',
      channel: 'CCHAN',
      channel_type: null,
      user: OWNER,
      ts: '1700000001.000200',
      thread_ts: null,
      text: '<@UBOT> take a look',
      event_ts: '1700000001.000200',
      team: 'TTEAM',
      is_owner: true,
      is_self: false,
      raw: ownerMention,
    });
  });

  it('does not hand off a non-owner mention under owner, and does under any', async () => {
    const mention = { ...ownerMention, user: OTHER };
    const owner = harness({ handoff: true, authors: 'owner' });
    await owner.router.appMention(mention, { eventId: 'EvM2' }, SELF);
    expect(owner.calls).toHaveLength(0);

    const any = harness({ handoff: true, authors: 'any' });
    await any.router.appMention(mention, { eventId: 'EvM2' }, SELF);
    expect(any.calls).toHaveLength(1);
    expect(any.calls[0]!.payload.is_owner).toBe(false);
  });

  it('hands off a Slack retry only once', async () => {
    const h = harness({ handoff: true });
    await h.router.appMention(ownerMention, { eventId: 'EvRetry' }, SELF);
    await h.router.appMention(ownerMention, { eventId: 'EvRetry' }, SELF);
    expect(h.calls).toHaveLength(1);
  });

  it('survives a failing command, counts it, and still answers the next DM', async () => {
    const h = harness({ handoff: true, fail: true });
    await h.router.appMention(ownerMention, { eventId: 'EvFail' }, SELF);
    expect(h.calls).toHaveLength(1);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({ eventId: 'EvFail', type: 'app_mention', reason: 'exited with 1' });
    expect(h.handoff!.stats()).toEqual({ handedOff: 0, failed: 1, consecutiveFailures: 1 });

    await h.router.message(ownerDm, { eventId: 'EvDM2' }, SELF);
    expect(h.dms).toEqual([ownerDm]);
  });

  it('spawns nothing when the hand-off is not configured', async () => {
    let spawned = 0;
    const h = harness({ handoff: false, runner: async () => { spawned += 1; } });
    await h.router.appMention(ownerMention, { eventId: 'EvA' }, SELF);
    await h.router.reactionAdded({ user: OWNER, item: { channel: 'C1', ts: '1.0' } }, { eventId: 'EvB' }, SELF);
    await h.router.message({ ...ownerDm, channel_type: 'channel' }, { eventId: 'EvC' }, SELF);
    expect(spawned).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(h.dms).toHaveLength(0);
  });
});

describe('spawnRunner', () => {
  it('writes the JSON to stdin with nothing from the event on argv', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-handoff-'));
    try {
      const out = join(dir, 'out.json');
      const script = join(dir, 'consumer.sh');
      await writeFile(script, `#!/bin/sh\necho "$#" > "${out}.argc"\ncat > "${out}"\n`);
      await chmod(script, 0o755);
      await spawnRunner([script], '{"type":"app_mention"}\n', 5000);
      expect(await readFile(out, 'utf8')).toBe('{"type":"app_mention"}\n');
      expect((await readFile(`${out}.argc`, 'utf8')).trim()).toBe('0');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects on a non-zero exit, a timeout, and a missing binary', async () => {
    await expect(spawnRunner(['sh', '-c', 'echo boom >&2; exit 3'], '{}', 5000)).rejects.toThrow('exited with 3: boom');
    await expect(spawnRunner(['sleep', '5'], '{}', 100)).rejects.toThrow('timed out after 100ms');
    await expect(spawnRunner(['/nonexistent/handoff-consumer'], '{}', 5000)).rejects.toThrow();
  });
});
