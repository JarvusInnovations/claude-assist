import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { UrgencyPipeline, type EvalContext, type UrgencyNotifier, type PermalinkResolver } from './pipeline.js';
import { MemoryUrgencyStore } from './store.js';
import { Roster } from './roster.js';
import type { ResidueJudge } from './classifier.js';
import type { ModelVerdict, SlackCandidate } from './types.js';

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

const OWNER = 'U_OWNER';
const TEAM = 'U_TEAM';

function roster() {
  return new Roster([{ id: TEAM, name: 'Julia' }]);
}

class RecordingNotifier implements UrgencyNotifier {
  fires: Array<{ gist: string; permalink: string | null }> = [];
  async fire(decision: { gist: string }, permalink: string | null): Promise<number> {
    this.fires.push({ gist: decision.gist, permalink });
    return this.fires.length; // fake notification id
  }
}

const permalinks: PermalinkResolver = { resolve: async () => 'https://slack/permalink' };

class StubJudge implements ResidueJudge {
  constructor(private urgent: boolean) {}
  calls = 0;
  async classify(): Promise<ModelVerdict> {
    this.calls++;
    return {
      urgent: this.urgent,
      gist: 'model gist',
      rationale: 'stub',
      confidence: 0.9,
      model: 'stub-model',
    };
  }
}

function candidate(over: Partial<SlackCandidate> = {}): SlackCandidate {
  return {
    channel: 'C1',
    ts: '1720620000.000100',
    threadTs: null,
    channelType: 'im',
    sender: TEAM,
    senderName: 'Julia',
    text: 'hi',
    isBot: false,
    ...over,
  };
}

const DM_CTX: EvalContext = {
  isDirectMessage: true,
  mentionsOwner: false,
  ownerRepliedAfter: false,
  threadContext: [],
};

// Daytime instant (08:00 ET) so quiet hours are off unless a test overrides.
const DAY = new Date('2026-07-10T12:00:00Z');
const NIGHT = new Date('2026-07-10T05:00:00Z'); // 01:00 ET

function makePipeline(judge: ResidueJudge | null = new StubJudge(false)) {
  const store = new MemoryUrgencyStore();
  const notifier = new RecordingNotifier();
  const pipeline = new UrgencyPipeline(store, judge, roster(), notifier, permalinks, log, {
    ownerId: OWNER,
    quietHours: { timeZone: 'America/New_York', startHour: 22, endHour: 7 },
    cooldownMs: 30 * 60 * 1000,
  });
  return { store, notifier, pipeline };
}

describe('UrgencyPipeline — earned interrupts', () => {
  it('a teammate DM signaling blockage interrupts, carrying gist + deep link', async () => {
    const { notifier, pipeline, store } = makePipeline();
    const d = await pipeline.process(
      candidate({ text: "I'm blocked and waiting on you for sign-off" }),
      DM_CTX,
      DAY
    );
    expect(d.verdict).toBe('interrupt');
    expect(d.interrupted).toBe(true);
    expect(notifier.fires).toHaveLength(1);
    expect(notifier.fires[0]!.permalink).toBe('https://slack/permalink');
    const row = await store.getCandidate('C1', '1720620000.000100');
    expect(row!.interrupted).toBe(true);
    expect(row!.permalink).toBe('https://slack/permalink');
  });
});

describe('UrgencyPipeline — boundaries (never interrupt)', () => {
  it("suppresses Chris's own message", async () => {
    const { notifier, pipeline } = makePipeline();
    const d = await pipeline.process(candidate({ sender: OWNER, text: 'note to self' }), DM_CTX, DAY);
    expect(d.verdict).toBe('suppressed');
    expect(notifier.fires).toHaveLength(0);
  });

  it('drops bot messages', async () => {
    const { notifier, pipeline } = makePipeline();
    const d = await pipeline.process(candidate({ isBot: true, text: 'URGENT deploy failed' }), DM_CTX, DAY);
    expect(d.interrupted).toBe(false);
    expect(notifier.fires).toHaveLength(0);
  });

  it('suppresses a message Chris has already replied to after', async () => {
    const { notifier, pipeline } = makePipeline();
    const d = await pipeline.process(
      candidate({ text: 'can you review this by EOD?' }),
      { ...DM_CTX, ownerRepliedAfter: true },
      DAY
    );
    expect(d.verdict).toBe('suppressed');
    expect(notifier.fires).toHaveLength(0);
  });
});

describe('UrgencyPipeline — thread dedup / cooldown', () => {
  it('interrupts once for a rapid multi-message urgent thread', async () => {
    const { notifier, pipeline } = makePipeline();
    const first = await pipeline.process(
      candidate({ ts: '1720620000.000100', text: 'blocked, need you now, can you help?' }),
      DM_CTX,
      DAY
    );
    const second = await pipeline.process(
      candidate({
        ts: '1720620030.000200',
        threadTs: '1720620000.000100',
        text: 'still blocked, waiting on you!',
      }),
      DM_CTX,
      DAY
    );
    expect(first.verdict).toBe('interrupt');
    expect(second.verdict).toBe('folded');
    expect(notifier.fires).toHaveLength(1);
  });
});

describe('UrgencyPipeline — quiet hours', () => {
  it('suppresses ordinary urgency overnight → near-miss', async () => {
    const { notifier, pipeline, store } = makePipeline();
    const d = await pipeline.process(candidate({ text: 'can you review by EOD?' }), DM_CTX, NIGHT);
    expect(d.verdict).toBe('near_miss');
    expect(d.nearMiss).toBe(true);
    expect(notifier.fires).toHaveLength(0);
    const nm = await store.listNearMisses(10);
    expect(nm).toHaveLength(1);
  });

  it('lets the emergency tier pierce quiet hours', async () => {
    const { notifier, pipeline } = makePipeline();
    const d = await pipeline.process(candidate({ text: 'EMERGENCY, prod is down' }), DM_CTX, NIGHT);
    expect(d.tier).toBe('emergency');
    expect(d.verdict).toBe('interrupt');
    expect(notifier.fires).toHaveLength(1);
  });
});

describe('UrgencyPipeline — model residue', () => {
  it('interrupts when the model judges a residue message urgent', async () => {
    const { notifier, pipeline } = makePipeline(new StubJudge(true));
    const d = await pipeline.process(candidate({ text: 'following up on earlier' }), DM_CTX, DAY);
    expect(d.classifier).toBe('model');
    expect(d.verdict).toBe('interrupt');
    expect(notifier.fires).toHaveLength(1);
  });

  it('near-misses when the model judges a residue message not urgent', async () => {
    const { notifier, pipeline, store } = makePipeline(new StubJudge(false));
    const d = await pipeline.process(candidate({ text: 'following up on earlier' }), DM_CTX, DAY);
    expect(d.verdict).toBe('near_miss');
    expect(notifier.fires).toHaveLength(0);
    expect(await store.listNearMisses(10)).toHaveLength(1);
  });

  it('defers residue to the digest when no model is configured', async () => {
    const { notifier, pipeline } = makePipeline(null);
    const d = await pipeline.process(candidate({ text: 'following up on earlier' }), DM_CTX, DAY);
    expect(d.verdict).toBe('near_miss');
    expect(notifier.fires).toHaveLength(0);
  });
});

describe('UrgencyPipeline — corrections change future classification', () => {
  it('a negative correction demotes a would-be interrupt to a near-miss', async () => {
    // Model would say not-urgent for residue; a strong negative sender weight
    // turns an explicit ask (normally urgent) into residue → the model then
    // routes it to the digest instead of interrupting.
    const { store, notifier, pipeline } = makePipeline(new StubJudge(false));

    // Baseline: an ask from this teammate interrupts.
    const before = await pipeline.process(
      candidate({ ts: '1720620000.000001', text: 'can you check this?' }),
      DM_CTX,
      DAY
    );
    expect(before.verdict).toBe('interrupt');

    // Chris corrects: this shouldn't have interrupted (two nudges past threshold).
    await store.adjustWeight('sender', TEAM, -0.5);
    await store.adjustWeight('sender', TEAM, -0.75);

    const after = await pipeline.process(
      candidate({ ts: '1720620999.000002', text: 'can you check this other thing?' }),
      DM_CTX,
      DAY
    );
    expect(after.tier).toBe('residue');
    expect(after.verdict).toBe('near_miss');
    expect(notifier.fires).toHaveLength(1); // only the baseline fired
  });
});
