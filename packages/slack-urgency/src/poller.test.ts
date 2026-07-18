import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import {
  buildCandidates,
  MENTION_SWEEP_CURSOR_ID,
  UrgencyPoller,
  type Conversation,
  type MentionHit,
  type RawSlackMessage,
  type SlackReader,
} from './poller.js';
import type { EvalContext, UrgencyPipeline } from './pipeline.js';
import { MemoryUrgencyStore } from './store.js';
import type { Decision, SlackCandidate } from './types.js';

const OWNER = 'U_OWNER';
const dm: Conversation = { id: 'D1', type: 'im' };
const channel: Conversation = { id: 'C1', type: 'channel' };

describe('buildCandidates', () => {
  it('skips the owner\'s own messages and bots as candidates', () => {
    const msgs: RawSlackMessage[] = [
      { ts: '1', user: OWNER, text: 'my own note' },
      { ts: '2', bot_id: 'B1', text: 'bot alert' },
      { ts: '3', user: 'U_TEAM', text: 'a real question?' },
    ];
    const { items, newestTs } = buildCandidates(msgs, dm, OWNER, 4);
    expect(items).toHaveLength(1);
    expect(items[0]!.candidate.sender).toBe('U_TEAM');
    expect(newestTs).toBe('3');
  });

  it('marks ownerRepliedAfter when the owner replied later in the same thread', () => {
    const msgs: RawSlackMessage[] = [
      { ts: '10', user: 'U_TEAM', text: 'can you look?', thread_ts: '10' },
      { ts: '11', user: OWNER, text: 'on it', thread_ts: '10' },
    ];
    const { items } = buildCandidates(msgs, dm, OWNER, 4);
    expect(items).toHaveLength(1);
    expect(items[0]!.ctx.ownerRepliedAfter).toBe(true);
  });

  it('does not mark ownerRepliedAfter across different threads', () => {
    const msgs: RawSlackMessage[] = [
      { ts: '10', user: 'U_TEAM', text: 'can you look?', thread_ts: '10' },
      { ts: '11', user: OWNER, text: 'unrelated reply', thread_ts: '99' },
    ];
    const { items } = buildCandidates(msgs, dm, OWNER, 4);
    expect(items[0]!.ctx.ownerRepliedAfter).toBe(false);
  });

  it('detects an @mention of the owner in a channel', () => {
    const msgs: RawSlackMessage[] = [{ ts: '5', user: 'U_TEAM', text: `hey <@${OWNER}> ping` }];
    const { items } = buildCandidates(msgs, channel, OWNER, 4);
    expect(items[0]!.ctx.mentionsOwner).toBe(true);
    expect(items[0]!.ctx.isDirectMessage).toBe(false);
  });

  it('builds preceding thread context (owner rendered as "the owner")', () => {
    const msgs: RawSlackMessage[] = [
      { ts: '1', user: OWNER, text: 'earlier note', thread_ts: '1' },
      { ts: '2', user: 'U_TEAM', text: 'and now the ask?', thread_ts: '1' },
    ];
    const { items } = buildCandidates(msgs, dm, OWNER, 4);
    expect(items[0]!.ctx.threadContext).toEqual([{ who: 'the owner', text: 'earlier note' }]);
  });
});

// ---------------------------------------------------------------------------
// sweepMentions
// ---------------------------------------------------------------------------

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => log,
  level: 'silent',
} as unknown as FastifyBaseLogger;

function hit(over: Partial<MentionHit> = {}): MentionHit {
  return {
    channel: 'C_FAR',
    channelType: 'channel',
    ts: '150.000000',
    user: 'U_TEAM',
    text: `<@${OWNER}> ping`,
    permalink: 'https://slack.example/link',
    ...over,
  };
}

function makeReader(
  hits: MentionHit[],
  overrides: Partial<SlackReader> = {}
): SlackReader & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    listDmConversations: async () => [],
    history: async (channelId: string) => {
      order.push(`history:${channelId}`);
      return [];
    },
    searchMentions: async () => {
      order.push('search');
      return hits;
    },
    permalink: async () => null,
    userName: async () => 'Teammate',
    ...overrides,
  };
}

function stubDecision(candidate: SlackCandidate, interrupted: boolean): Decision {
  return {
    candidate,
    tier: 'urgent',
    verdict: interrupted ? 'interrupt' : 'near_miss',
    classifier: 'deterministic',
    model: null,
    gist: '',
    signals: [],
    rationale: null,
    confidence: null,
    interrupted,
    nearMiss: !interrupted,
  };
}

function makePipeline(interrupted = false) {
  const calls: Array<{
    candidate: SlackCandidate;
    ctx: EvalContext;
    permalink: string | null | undefined;
  }> = [];
  const pipeline = {
    process: async (
      candidate: SlackCandidate,
      ctx: EvalContext,
      _now: Date,
      permalink?: string | null
    ): Promise<Decision> => {
      calls.push({ candidate, ctx, permalink });
      return stubDecision(candidate, interrupted);
    },
  } as unknown as UrgencyPipeline;
  return { pipeline, calls };
}

function makePoller(reader: SlackReader, pipeline: UrgencyPipeline, store: MemoryUrgencyStore) {
  return new UrgencyPoller(reader, pipeline, store, log, { ownerId: OWNER, watchChannels: [] });
}

describe('UrgencyPoller.sweepMentions', () => {
  it('seeds the cursor to the newest mention on first sight and processes nothing', async () => {
    const store = new MemoryUrgencyStore();
    const { pipeline, calls } = makePipeline();
    const reader = makeReader([hit({ ts: '150.000000' }), hit({ ts: '140.000000' })]);
    const poller = makePoller(reader, pipeline, store);

    const result = await poller.sweepMentions(new Date());
    expect(result).toEqual({ processed: 0, interrupts: 0 });
    expect(calls).toHaveLength(0);
    expect(await store.getCursor(MENTION_SWEEP_CURSOR_ID)).toBe('150.000000');
  });

  it('pipelines fresh mentions with mention ctx, empty thread context, and the search permalink', async () => {
    const store = new MemoryUrgencyStore();
    await store.setCursor(MENTION_SWEEP_CURSOR_ID, '100.000000');
    const { pipeline, calls } = makePipeline(true);
    const reader = makeReader([hit({ ts: '150.000000' })]);
    const poller = makePoller(reader, pipeline, store);

    const result = await poller.sweepMentions(new Date());
    expect(result).toEqual({ processed: 1, interrupts: 1 });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.candidate).toMatchObject({
      channel: 'C_FAR',
      ts: '150.000000',
      channelType: 'channel',
      sender: 'U_TEAM',
      senderName: 'Teammate',
      isBot: false,
    });
    expect(call.ctx).toEqual({
      isDirectMessage: false,
      mentionsOwner: true,
      ownerRepliedAfter: false,
      threadContext: [],
    });
    expect(call.permalink).toBe('https://slack.example/link');
    expect(await store.getCursor(MENTION_SWEEP_CURSOR_ID)).toBe('150.000000');
  });

  it('skips owner-sent, bot, and authorless matches but still advances the cursor', async () => {
    const store = new MemoryUrgencyStore();
    await store.setCursor(MENTION_SWEEP_CURSOR_ID, '100.000000');
    const { pipeline, calls } = makePipeline();
    const reader = makeReader([
      hit({ ts: '180.000000', user: undefined }),
      hit({ ts: '170.000000', bot_id: 'B1' }),
      hit({ ts: '160.000000', user: OWNER }),
    ]);
    const poller = makePoller(reader, pipeline, store);

    const result = await poller.sweepMentions(new Date());
    expect(result).toEqual({ processed: 0, interrupts: 0 });
    expect(calls).toHaveLength(0);
    expect(await store.getCursor(MENTION_SWEEP_CURSOR_ID)).toBe('180.000000');
  });

  it('dedups a mention the conversation poller already recorded (channel+ts)', async () => {
    const store = new MemoryUrgencyStore();
    await store.setCursor(MENTION_SWEEP_CURSOR_ID, '100.000000');
    const seen = hit({ channel: 'D1', channelType: 'im', ts: '150.000000' });
    await store.recordCandidate({
      decision: stubDecision(
        {
          channel: 'D1',
          ts: '150.000000',
          threadTs: null,
          channelType: 'im',
          sender: 'U_TEAM',
          senderName: 'Teammate',
          text: 'already handled',
          isBot: false,
        },
        false
      ),
      permalink: null,
      notificationId: null,
      messageTs: new Date(150_000),
    });
    const { pipeline, calls } = makePipeline();
    const reader = makeReader([hit({ ts: '160.000000' }), seen]);
    const poller = makePoller(reader, pipeline, store);

    const result = await poller.sweepMentions(new Date());
    expect(result.processed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.candidate.ts).toBe('160.000000');
    expect(await store.getCursor(MENTION_SWEEP_CURSOR_ID)).toBe('160.000000');
  });

  it('ignores matches at or below the cursor and leaves it unchanged', async () => {
    const store = new MemoryUrgencyStore();
    await store.setCursor(MENTION_SWEEP_CURSOR_ID, '150.000000');
    const { pipeline, calls } = makePipeline();
    const reader = makeReader([hit({ ts: '150.000000' }), hit({ ts: '140.000000' })]);
    const poller = makePoller(reader, pipeline, store);

    const result = await poller.sweepMentions(new Date());
    expect(result).toEqual({ processed: 0, interrupts: 0 });
    expect(calls).toHaveLength(0);
    expect(await store.getCursor(MENTION_SWEEP_CURSOR_ID)).toBe('150.000000');
  });

  it('runs before the conversation loop in pollOnce and rolls into its totals', async () => {
    const store = new MemoryUrgencyStore();
    await store.setCursor(MENTION_SWEEP_CURSOR_ID, '100.000000');
    await store.setCursor('D1', '100.000000');
    const { pipeline } = makePipeline(true);
    const reader = makeReader([hit({ ts: '150.000000' })], {
      listDmConversations: async () => [{ id: 'D1', type: 'im' }],
    });
    const poller = makePoller(reader, pipeline, store);

    const result = await poller.pollOnce(new Date());
    expect(result).toEqual({ processed: 1, interrupts: 1 });
    expect(reader.order).toEqual(['search', 'history:D1']);
  });
});
