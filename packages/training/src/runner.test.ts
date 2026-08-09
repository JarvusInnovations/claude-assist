import { describe, expect, it } from 'bun:test';
import type {
  ApprovalRecord,
  ApprovalRequestInput,
  ApprovalService,
} from '@jarvus/claude-assist-core';
import { MemoryWeekPlanStore } from './memory-store.js';
import {
  APPROVAL_KIND,
  approvalKeyFor,
  reconcileProposals,
  runWeeklyPlanning,
  type WeeklyPlanningDeps,
} from './runner.js';
import type { PlanInputs, SynthesizedWeek } from './types.js';
import type { WeekPlanner } from './services/planner.js';

const log = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return log;
  },
  level: 'info',
  silent() {},
} as unknown as import('fastify').FastifyBaseLogger;

/** A planner that answers instantly with a fixed week. */
function planner(week?: Partial<SynthesizedWeek>): WeekPlanner & { calls: PlanInputs[] } {
  const calls: PlanInputs[] = [];
  return {
    modelId: 'test-model',
    calls,
    async synthesize(inputs: PlanInputs) {
      calls.push(inputs);
      return {
        summary: 'Consistency week',
        rationale: 'Three short runs.',
        adjustments: ['Dropped the long run'],
        sessions: [
          {
            date: inputs.weekStart,
            kind: 'rest',
            title: 'Rest',
            detail: '',
            distanceMiles: null,
            durationMinutes: null,
            why: 'Jammed calendar',
            venue: 'either',
          },
        ],
        ...week,
      };
    },
  };
}

/** An approvals service that records requests and never resolves on its own. */
class FakeApprovals implements ApprovalService {
  readonly requests: ApprovalRequestInput[] = [];
  readonly records = new Map<string, ApprovalRecord>();
  private seq = 0;

  async request(input: ApprovalRequestInput): Promise<ApprovalRecord> {
    this.requests.push(input);
    const existing = [...this.records.values()].find(
      (r) => r.dedupeKey === (input.dedupeKey ?? null) && r.status === 'pending'
    );
    if (existing) return existing;
    const record: ApprovalRecord = {
      id: `approval-${++this.seq}`,
      kind: input.kind,
      requestedBy: input.requestedBy,
      title: input.title,
      body: input.body,
      payload: input.payload ?? {},
      status: 'pending',
      dedupeKey: input.dedupeKey ?? null,
      resolution: null,
      resolvedBy: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      resolvedAt: null,
    };
    this.records.set(record.id, record);
    return record;
  }

  async get(id: string) {
    return this.records.get(id) ?? null;
  }
  async list() {
    return [...this.records.values()];
  }
  async resolve(id: string, resolution: { decision: 'approved' | 'denied' }) {
    const record = this.records.get(id)!;
    record.status = resolution.decision;
    record.resolvedAt = new Date().toISOString();
    return record;
  }
  async findResolved(dedupeKey: string) {
    return (
      [...this.records.values()].find((r) => r.dedupeKey === dedupeKey && r.status !== 'pending') ??
      null
    );
  }
  /** Force a terminal state the resolve API can't produce (expiry sweep). */
  expire(id: string) {
    this.records.get(id)!.status = 'expired';
  }
}

function deps(overrides: Partial<WeeklyPlanningDeps> = {}): WeeklyPlanningDeps {
  return {
    store: new MemoryWeekPlanStore(),
    planner: planner(),
    approvals: new FakeApprovals(),
    log,
    timeZone: 'America/New_York',
    weather: null,
    // No calendar CLI in a test: the fetcher stands in for gws-axi.
    eventsFetcher: async () => ({ events: [], error: null }),
    now: new Date('2026-08-08T14:00:00Z'), // a Saturday
    ...overrides,
  };
}

describe('runWeeklyPlanning', () => {
  it('plans the week AFTER the current one', async () => {
    const d = deps();
    const result = await runWeeklyPlanning(d);
    // 2026-08-08 is a Saturday; the week being planned starts Monday the 10th.
    expect(result.weekStart).toBe('2026-08-10');
    expect(result.outcome).toBe('proposed');
  });

  it('stores the week as PROPOSED and returns without waiting for a human', async () => {
    const store = new MemoryWeekPlanStore();
    const approvals = new FakeApprovals();
    const result = await runWeeklyPlanning(deps({ store, approvals }));

    const plan = await store.byWeek('2026-08-10');
    expect(plan!.status).toBe('proposed');
    expect(plan!.approvalId).toBe(result.approvalId!);
    // Nothing is active: the briefing has nothing to render until a human acts.
    expect(await store.activeForDate('2026-08-12')).toBeNull();

    expect(approvals.requests).toHaveLength(1);
    expect(approvals.requests[0]!.kind).toBe(APPROVAL_KIND);
    expect(approvals.requests[0]!.dedupeKey).toBe(approvalKeyFor('2026-08-10'));
    // A training week is not an interrupt.
    expect(approvals.requests[0]!.priority).toBe('notice');
  });

  it('puts the adjustment list in the body — that is what is being approved', async () => {
    const approvals = new FakeApprovals();
    await runWeeklyPlanning(deps({ approvals }));
    expect(approvals.requests[0]!.body).toContain('Dropped the long run');
  });

  it('preflights to a clean exit when no metered-model credential is configured', async () => {
    const store = new MemoryWeekPlanStore();
    const approvals = new FakeApprovals();
    const result = await runWeeklyPlanning(deps({ store, approvals, planner: null }));

    expect(result.outcome).toBe('skipped_no_planner');
    // Nothing written, nothing asked: an unconsidered week proposed for approval
    // would be indistinguishable from a considered one.
    expect(store.plans).toHaveLength(0);
    expect(approvals.requests).toHaveLength(0);
  });

  it('does not stack a second proposal on a week that already has one open', async () => {
    const store = new MemoryWeekPlanStore();
    const approvals = new FakeApprovals();
    const p = planner();
    await runWeeklyPlanning(deps({ store, approvals, planner: p }));
    const second = await runWeeklyPlanning(deps({ store, approvals, planner: p }));

    expect(second.outcome).toBe('already_pending');
    expect(store.plans).toHaveLength(1);
    expect(approvals.requests).toHaveLength(1);
    // And no second synthesis was paid for.
    expect(p.calls).toHaveLength(1);
  });

  it('activates without a gate, loudly, when no approvals module is loaded', async () => {
    const store = new MemoryWeekPlanStore();
    const result = await runWeeklyPlanning(deps({ store, approvals: undefined }));
    expect(result.outcome).toBe('auto_activated');
    expect((await store.byWeek('2026-08-10'))!.status).toBe('active');
  });

  it('plans through a degraded source and names what was missing', async () => {
    const approvals = new FakeApprovals();
    const p = planner();
    const result = await runWeeklyPlanning(
      deps({
        approvals,
        planner: p,
        // History is available; the calendar CLI is not, and the forecast is
        // unconfigured in these deps.
        activityHistory: async () => [],
        eventsFetcher: async () => ({ events: [], error: 'gws-axi not found' }),
      })
    );
    expect(result.degraded).toEqual(['forecast', 'calendar']);
    expect(p.calls[0]!.availability.error).toContain('gws-axi not found');
    expect(approvals.requests[0]!.body).toContain('planned without: forecast, calendar');
  });

  it('feeds the previously active week to the synthesis as prior context', async () => {
    const store = new MemoryWeekPlanStore();
    const approvals = new FakeApprovals();

    // Week 1: propose and approve.
    await runWeeklyPlanning(deps({ store, approvals, now: new Date('2026-08-01T14:00:00Z') }));
    const first = await store.byWeek('2026-08-03', 'proposed');
    await approvals.resolve(first!.approvalId!, { decision: 'approved' });
    await reconcileProposals({ store, approvals, log });

    // Week 2: the planner should see week 1.
    const p = planner();
    await runWeeklyPlanning(deps({ store, approvals, planner: p }));
    expect(p.calls[0]!.priorWeek?.weekStart).toBe('2026-08-03');
    expect(p.calls[0]!.priorWeek?.summary).toBe('Consistency week');
  });

  it('honors an explicit weekStart for a manual regeneration', async () => {
    const result = await runWeeklyPlanning(deps({ weekStart: '2026-09-07' }));
    expect(result.weekStart).toBe('2026-09-07');
  });
});

describe('reconcileProposals', () => {
  async function proposed() {
    const store = new MemoryWeekPlanStore();
    const approvals = new FakeApprovals();
    const result = await runWeeklyPlanning(deps({ store, approvals }));
    return { store, approvals, result };
  }

  it('leaves a still-pending gate alone', async () => {
    const { store, approvals } = await proposed();
    const outcome = await reconcileProposals({ store, approvals, log });
    expect(outcome).toEqual({ checked: 1, activated: 0, rejected: 0, expired: 0 });
    expect((await store.byWeek('2026-08-10'))!.status).toBe('proposed');
  });

  it('activates an approved week', async () => {
    const { store, approvals, result } = await proposed();
    await approvals.resolve(result.approvalId!, { decision: 'approved' });

    const outcome = await reconcileProposals({ store, approvals, log });
    expect(outcome.activated).toBe(1);
    expect((await store.activeForDate('2026-08-12'))!.summary).toBe('Consistency week');
  });

  it('rejects a denied week and leaves the previous one standing', async () => {
    const store = new MemoryWeekPlanStore();
    const approvals = new FakeApprovals();

    await runWeeklyPlanning(deps({ store, approvals, now: new Date('2026-08-01T14:00:00Z') }));
    const first = await store.byWeek('2026-08-03', 'proposed');
    await approvals.resolve(first!.approvalId!, { decision: 'approved' });
    await reconcileProposals({ store, approvals, log });

    const second = await runWeeklyPlanning(deps({ store, approvals }));
    await approvals.resolve(second.approvalId!, { decision: 'denied' });
    const outcome = await reconcileProposals({ store, approvals, log });

    expect(outcome.rejected).toBe(1);
    expect((await store.byWeek('2026-08-10', 'rejected'))).not.toBeNull();
    // The approved week 1 is untouched.
    expect((await store.activeForDate('2026-08-05'))!.weekStart).toBe('2026-08-03');
  });

  it('closes a gate that expired unanswered — it fails closed, not open', async () => {
    const { store, approvals, result } = await proposed();
    approvals.expire(result.approvalId!);

    const outcome = await reconcileProposals({ store, approvals, log });
    expect(outcome.expired).toBe(1);
    expect((await store.byWeek('2026-08-10'))!.status).toBe('expired');
    expect(await store.activeForDate('2026-08-12')).toBeNull();
  });

  it('supersedes a prior active plan when a re-proposal for the same week lands', async () => {
    const store = new MemoryWeekPlanStore();
    const approvals = new FakeApprovals();

    const first = await runWeeklyPlanning(deps({ store, approvals }));
    await approvals.resolve(first.approvalId!, { decision: 'approved' });
    await reconcileProposals({ store, approvals, log });

    const second = await runWeeklyPlanning(deps({ store, approvals }));
    await approvals.resolve(second.approvalId!, { decision: 'approved' });
    await reconcileProposals({ store, approvals, log });

    const active = store.plans.filter((p) => p.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(second.planId!);
    expect(store.plans.filter((p) => p.status === 'superseded')).toHaveLength(1);
  });

  it('recovers a proposal whose approval id never landed, via the dedupe key', async () => {
    const { store, approvals, result } = await proposed();
    // Simulate a crash between the insert and attachApproval.
    (await store.byWeek('2026-08-10'))!.approvalId = null;
    await approvals.resolve(result.approvalId!, { decision: 'approved' });

    const outcome = await reconcileProposals({ store, approvals, log });
    expect(outcome.activated).toBe(1);
  });

  it('is a no-op without an approvals module', async () => {
    const store = new MemoryWeekPlanStore();
    const outcome = await reconcileProposals({ store, approvals: undefined, log });
    expect(outcome).toEqual({ checked: 0, activated: 0, rejected: 0, expired: 0 });
  });
});
