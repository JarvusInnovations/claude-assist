import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import type { EmailRecord, EmailAnalysis } from '../types.js';
import { EmailUrgencyPipeline, type EmailInterruptNotifier, type EvalContext } from './urgency-pipeline.js';
import { MemoryEmailAttentionStore } from './attention-store.js';
import type { EmailResidueJudge, EmailModelVerdict } from './email-residue.js';
import type { OpportunityJudge, OpportunityVerdict } from './opportunity.js';

const log = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return log; },
} as unknown as FastifyBaseLogger;

const OWNER = new Set(['owner@own.test']);
const QUIET = { timeZone: 'America/New_York', startHour: 22, endHour: 7 };
const DAYTIME = new Date('2026-07-11T16:00:00Z'); // 12:00 EDT — awake
const NIGHT = new Date('2026-07-11T04:00:00Z'); // 00:00 EDT — quiet

function makeEmail(over: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: 1,
    account_id: 1,
    message_id: 'm1',
    thread_id: null,
    date: DAYTIME,
    from_address: 'nate@client.org',
    from_name: 'Nate',
    to_addresses: ['owner@own.test'],
    cc_addresses: [],
    subject: 'Hello',
    snippet: null,
    gmail_labels: [],
    body_text: 'body',
    body_html: null,
    has_attachments: false,
    analysis: null,
    planned_labels: null,
    gmail_action: null,
    digest_section: null,
    triage_confidence: null,
    rule_matched_id: null,
    workflow_status: 'triaged',
    triaged_at: null,
    reviewed_at: null,
    executed_at: null,
    alerted_at: null,
    applied_labels: null,
    applied_gmail_action: null,
    applied_at: null,
    execution_notes: null,
    execution_error: null,
    execution_error_at: null,
    last_error: null,
    last_error_at: null,
    triage_attempts: 0,
    synced_at: DAYTIME,
    updated_at: DAYTIME,
    ...over,
  };
}

function analysis(over: Partial<EmailAnalysis> = {}): EmailAnalysis {
  return {
    overview: 'An email.',
    mentioned_people: [],
    mentioned_organizations: [],
    potential_action_items: [],
    sender_type: 'human',
    message_type: 'personal',
    unsubscribe_link: null,
    rationale: '',
    ...over,
  };
}

function ctx(over: Partial<EvalContext> = {}): EvalContext {
  return {
    ownerAddresses: OWNER,
    ownerLabel: 'Owner',
    whitelist: new Set(['nate@client.org']),
    clientContacts: new Set(['ap@client.org']),
    teamDomains: ['team.test'],
    threadHasOwnerParticipation: false,
    recipientNames: ['Owner'],
    threadSummary: null,
    ...over,
  };
}

class StubResidue implements EmailResidueJudge {
  constructor(private v: Partial<EmailModelVerdict>) {}
  calls = 0;
  async judge(): Promise<EmailModelVerdict> {
    this.calls++;
    return {
      directedAsk: false,
      cannotWaitAnHour: false,
      emergency: false,
      gist: 'stub gist',
      confidence: 0.9,
      rationale: 'stub',
      model: 'stub-haiku',
      ...this.v,
    };
  }
}

class StubOpportunity implements OpportunityJudge {
  constructor(private v: Partial<OpportunityVerdict>) {}
  calls = 0;
  async evaluate(): Promise<OpportunityVerdict> {
    this.calls++;
    return { match: false, high: false, reasoning: 'stub reasoning', model: 'stub-haiku', ...this.v };
  }
}

function build(opts: {
  residue?: EmailResidueJudge | null;
  opportunity?: OpportunityJudge | null;
} = {}) {
  const store = new MemoryEmailAttentionStore();
  const fires: number[] = [];
  const notifier: EmailInterruptNotifier = {
    async fire(_d, email) {
      fires.push(email.id);
      return 100 + email.id;
    },
  };
  const pipeline = new EmailUrgencyPipeline(
    store,
    opts.residue ?? null,
    opts.opportunity ?? null,
    notifier,
    log,
    { quietHours: QUIET }
  );
  return { pipeline, store, fires };
}

describe('EmailUrgencyPipeline — verdict classes', () => {
  it('1. RFQ blast (opportunity no-match) → neither, calm', async () => {
    const { pipeline, store } = build({ opportunity: new StubOpportunity({ match: false }) });
    const d = await pipeline.process(
      makeEmail({ from_address: 'bids@portal.test', subject: 'RFQ 24-99: Bridge Painting', to_addresses: ['list@portal.test'] }),
      analysis({ overview: 'A bid notice.' }),
      ctx(),
      DAYTIME
    );
    expect(d.tier).toBe('neither');
    expect(d.opportunity?.match).toBe(false);
    expect(store.rows.size).toBe(0);
  });

  it('RFQ match → ATTENTION with reasoning', async () => {
    const { pipeline, store } = build({ opportunity: new StubOpportunity({ match: true, reasoning: 'GTFS data platform work' }) });
    const d = await pipeline.process(
      makeEmail({ from_address: 'bids@portal.test', subject: 'RFP: Transit data platform' }),
      analysis(),
      ctx(),
      DAYTIME
    );
    expect(d.tier).toBe('attention');
    expect(d.reason).toContain('GTFS data platform work');
    expect(store.rows.get(1)?.opportunity_match).toBe(true);
  });

  it('RFQ watchlist HIGH → ATTENTION flagged high', async () => {
    const { pipeline, store } = build({ opportunity: new StubOpportunity({ match: true, high: true, reasoning: 'watchlist: Parks reservation platform' }) });
    const d = await pipeline.process(
      makeEmail({ from_address: 'bids@portal.test', subject: 'Notice of Intent: reservation system' }),
      analysis(),
      ctx(),
      DAYTIME
    );
    expect(d.tier).toBe('attention');
    expect(d.opportunity?.high).toBe(true);
    expect(store.rows.get(1)?.opportunity_high).toBe(true);
    expect(d.reason).toContain('HIGH');
  });

  it('2. cold outreach (stranger, first contact) → neither + spam suggestion', async () => {
    const { pipeline, store } = build({ residue: new StubResidue({ directedAsk: true, cannotWaitAnHour: true }) });
    const d = await pipeline.process(
      makeEmail({
        from_address: 'jay@freshvcfund.test',
        from_name: 'Jay',
        to_addresses: ['owner@own.test'],
        subject: 'Startup cohort',
        body_text: 'Hi Owner, holding a spot in the early-stage founders cohort. Can I share info? Reply no thanks if not a fit.',
      }),
      analysis(),
      ctx(),
      DAYTIME
    );
    expect(d.tier).toBe('neither');
    expect(d.spamSuggested).toBe(true);
    expect(store.rows.size).toBe(0);
  });

  it('3. team-outward FYI, owner CC-only, no ask → neither (no model call)', async () => {
    const residue = new StubResidue({ directedAsk: true });
    const { pipeline, store } = build({ residue });
    const d = await pipeline.process(
      makeEmail({
        from_address: 'teammate@team.test',
        to_addresses: ['client@external.test'],
        cc_addresses: ['owner@own.test'],
        subject: 'Sent the deck',
        body_text: 'Sharing the deck with the client. Copying you.',
      }),
      analysis(),
      ctx(),
      DAYTIME
    );
    expect(d.tier).toBe('neither');
    expect(residue.calls).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  it('4. thread-client-reply promotion → ATTENTION', async () => {
    const residue = new StubResidue({ directedAsk: false, cannotWaitAnHour: false });
    const { pipeline, store } = build({ residue });
    const d = await pipeline.process(
      makeEmail({
        from_address: 'vendor@external.test',
        thread_id: 't-42',
        to_addresses: ['teammate@team.test'],
        cc_addresses: ['owner@own.test'],
        subject: 'Re: Statement of work',
        body_text: 'Following up on the thread below.',
      }),
      analysis(),
      ctx({ threadHasOwnerParticipation: true }),
      DAYTIME
    );
    expect(d.tier).toBe('attention');
  });

  it('5. CC-only, no ask, from whitelist → neither (no model call)', async () => {
    const residue = new StubResidue({ directedAsk: true });
    const { pipeline } = build({ residue });
    const d = await pipeline.process(
      makeEmail({
        from_address: 'nate@client.org',
        to_addresses: ['someone@client.org'],
        cc_addresses: ['owner@own.test'],
        subject: 'FYI notes',
        body_text: 'Just looping you in, nothing needed.',
      }),
      analysis(),
      ctx(),
      DAYTIME
    );
    expect(d.tier).toBe('neither');
    expect(residue.calls).toBe(0);
  });

  it('6. client-AP substantive mail → ATTENTION (model judges directedAsk)', async () => {
    const residue = new StubResidue({ directedAsk: true, cannotWaitAnHour: false, rationale: 'AP asks owner to confirm the PO' });
    const { pipeline, store } = build({ residue });
    const d = await pipeline.process(
      makeEmail({
        from_address: 'ap@client.org',
        from_name: 'Accounts Payable',
        to_addresses: ['owner@own.test'],
        subject: 'Invoice #4821 — PO confirmation',
        body_text: 'Please confirm the PO number so we can process payment.',
      }),
      analysis(),
      ctx(),
      DAYTIME
    );
    expect(d.tier).toBe('attention');
    expect(residue.calls).toBe(1);
    expect(store.rows.get(1)?.tier).toBe('attention');
  });

  it('7. automated-as-human (Chewy class) → neither, no model call', async () => {
    const residue = new StubResidue({ directedAsk: true, cannotWaitAnHour: true });
    const { pipeline } = build({ residue });
    const d = await pipeline.process(
      makeEmail({
        from_address: 'notifications@shop.test',
        from_name: 'Shop',
        to_addresses: ['owner@own.test'],
        subject: 'Your order shipped',
        body_text: 'Track your package. Deliver by tomorrow.',
      }),
      analysis({ sender_type: 'human', message_type: 'alert' }),
      ctx({ whitelist: new Set() }),
      DAYTIME
    );
    expect(d.tier).toBe('neither');
    expect(residue.calls).toBe(0);
  });

  it('8. self-forward → neither', async () => {
    const { pipeline } = build({ residue: new StubResidue({ directedAsk: true, cannotWaitAnHour: true }) });
    const d = await pipeline.process(
      makeEmail({ from_address: 'owner@own.test', to_addresses: ['owner@own.test'], subject: 'Fwd: notes to self' }),
      analysis(),
      ctx(),
      DAYTIME
    );
    expect(d.tier).toBe('neither');
  });

  it('deterministic INTERRUPT: known human, directed, deadline keyword → dispatched (no model)', async () => {
    const residue = new StubResidue({});
    const { pipeline, store, fires } = build({ residue });
    const d = await pipeline.process(
      makeEmail({ from_address: 'nate@client.org', to_addresses: ['owner@own.test'], subject: 'SOW', body_text: 'I am blocked on this, need it by end of day.' }),
      analysis(),
      ctx(),
      DAYTIME
    );
    expect(d.tier).toBe('interrupt');
    expect(d.interrupted).toBe(true);
    expect(residue.calls).toBe(0);
    expect(fires).toEqual([1]);
    expect(store.rows.get(1)?.verdict).toBe('interrupt');
  });

  it('residue INTERRUPT: directed known human, model says cannot wait an hour', async () => {
    const residue = new StubResidue({ directedAsk: true, cannotWaitAnHour: true, rationale: 'blocked on owner decision' });
    const { pipeline, fires } = build({ residue });
    const d = await pipeline.process(
      makeEmail({ from_address: 'nate@client.org', to_addresses: ['owner@own.test'], subject: 'Decision needed', body_text: 'The client cannot move ahead until you approve the final scope.' }),
      analysis(),
      ctx(),
      DAYTIME
    );
    expect(d.tier).toBe('interrupt');
    expect(d.classifier).toBe('model');
    expect(fires).toEqual([1]);
  });
});

describe('EmailUrgencyPipeline — quiet hours', () => {
  it('holds an INTERRUPT raised in quiet hours (no dispatch, flagged quiet_held)', async () => {
    const { pipeline, store, fires } = build({});
    const d = await pipeline.process(
      makeEmail({ from_address: 'nate@client.org', to_addresses: ['owner@own.test'], body_text: 'blocked on you, need it by end of day', date: NIGHT }),
      analysis(),
      ctx(),
      NIGHT
    );
    expect(d.tier).toBe('interrupt');
    expect(d.interrupted).toBe(false);
    expect(d.quietHeld).toBe(true);
    expect(d.verdict).toBe('quiet_held');
    expect(fires.length).toBe(0);
    expect(store.rows.get(1)?.quiet_held).toBe(true);
  });

  it('an emergency inference pierces quiet hours and interrupts', async () => {
    const { pipeline, fires } = build({});
    const d = await pipeline.process(
      makeEmail({ from_address: 'nate@client.org', to_addresses: ['owner@own.test'], subject: 'URGENT', body_text: 'production down, outage — need you now', date: NIGHT }),
      analysis(),
      ctx(),
      NIGHT
    );
    expect(d.tier).toBe('interrupt');
    expect(d.interrupted).toBe(true);
    expect(d.quietHeld).toBe(false);
    expect(fires).toEqual([1]);
  });

  it('a daytime INTERRUPT dispatches (boundary: 07:00 end is awake)', async () => {
    const { pipeline, fires } = build({});
    const d = await pipeline.process(
      makeEmail({ from_address: 'nate@client.org', to_addresses: ['owner@own.test'], body_text: 'blocked on you, need it by end of day' }),
      analysis(),
      ctx(),
      DAYTIME
    );
    expect(d.interrupted).toBe(true);
    expect(fires).toEqual([1]);
  });
});
