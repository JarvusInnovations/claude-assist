/**
 * In-memory WeekPlanStore — the seam the runner's tests drive.
 *
 * It reproduces the two partial unique indexes from the migration (one active
 * and one proposed plan per week), because those are exactly the invariants the
 * approval dance depends on; a memory store that let them slip would make the
 * tests pass on a shape Postgres would reject.
 */

import type { NewWeekPlan, WeekPlanStore } from './store.js';
import type { PlanInputs, WeekPlan, WeekPlanStatus } from './types.js';
import { addDays } from './week.js';

export class MemoryWeekPlanStore implements WeekPlanStore {
  readonly plans: WeekPlan[] = [];
  private seq = 0;

  async insertProposed(input: NewWeekPlan): Promise<WeekPlan | null> {
    if (this.plans.some((p) => p.weekStart === input.weekStart && p.status === 'proposed')) {
      return null;
    }
    const plan: WeekPlan = {
      id: `plan-${++this.seq}`,
      weekStart: input.weekStart,
      status: 'proposed',
      summary: input.summary,
      rationale: input.rationale,
      adjustments: input.adjustments,
      sessions: input.sessions,
      inputs: input.inputs as PlanInputs,
      approvalId: null,
      approvalKey: input.approvalKey,
      model: input.model,
      generatedAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.plans.push(plan);
    return plan;
  }

  async activeForDate(dateIso: string): Promise<WeekPlan | null> {
    return (
      this.plans.find(
        (p) =>
          p.status === 'active' && p.weekStart <= dateIso && addDays(p.weekStart, 6) >= dateIso
      ) ?? null
    );
  }

  async byWeek(weekStart: string, status?: WeekPlanStatus): Promise<WeekPlan | null> {
    const matches = this.plans.filter(
      (p) => p.weekStart === weekStart && (status ? p.status === status : true)
    );
    return matches[matches.length - 1] ?? null;
  }

  async listProposed(): Promise<WeekPlan[]> {
    return this.plans.filter((p) => p.status === 'proposed');
  }

  async list(limit: number): Promise<WeekPlan[]> {
    return [...this.plans].reverse().slice(0, limit);
  }

  async attachApproval(id: string, approvalId: string): Promise<void> {
    const plan = this.plans.find((p) => p.id === id);
    if (plan) plan.approvalId = approvalId;
  }

  async activate(id: string): Promise<WeekPlan | null> {
    const plan = this.plans.find((p) => p.id === id && p.status === 'proposed');
    if (!plan) return null;
    for (const other of this.plans) {
      if (other.weekStart === plan.weekStart && other.status === 'active') {
        other.status = 'superseded';
      }
    }
    plan.status = 'active';
    plan.resolvedAt = new Date().toISOString();
    return plan;
  }

  async close(id: string, status: 'rejected' | 'expired'): Promise<void> {
    const plan = this.plans.find((p) => p.id === id && p.status === 'proposed');
    if (!plan) return;
    plan.status = status;
    plan.resolvedAt = new Date().toISOString();
  }
}
