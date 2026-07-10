/**
 * PlanProvider — the one place that goes calendar → classifier → alert plan.
 *
 * Shared by the daily briefing (full-day plan for the will-alert list), the
 * alert scheduler (a rolling near-term window), and the /briefing/alert-plan
 * route. Encapsulates the gws-axi read, the override load, and the resolve so
 * none of the three re-implements the wiring. The calendar fetch is injected so
 * tests can drive it with fixtures.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { AlertPlanItem } from '../types.js';
import type { OverrideStore } from './overrides.js';
import type { JoinRequiredModel } from '../classifier/llm.js';
import { resolveAlertPlan } from './plan.js';
import { fetchEvents, type CalendarReadResult, type FetchEventsOptions } from '../calendar/gws-axi.js';
import { todayIsoInTz, zonedDayWindow } from '../time.js';

export type CalendarFetcher = (opts: FetchEventsOptions) => Promise<CalendarReadResult>;

export interface PlanProviderDeps {
  overrides: OverrideStore;
  model?: JoinRequiredModel | null;
  log: FastifyBaseLogger;
  timeZone: string;
  /** gws-axi binary + account passthrough. */
  gwsBin?: string;
  account?: string;
  /** Injectable for tests; defaults to the real gws-axi fetch. */
  fetcher?: CalendarFetcher;
}

export interface DayPlan {
  dateIso: string;
  items: AlertPlanItem[];
  calendarError: string | null;
}

export class PlanProvider {
  constructor(private deps: PlanProviderDeps) {}

  private fetch(opts: { fromIso: string; toIso: string }): Promise<CalendarReadResult> {
    const fetcher = this.deps.fetcher ?? fetchEvents;
    return fetcher({
      fromIso: opts.fromIso,
      toIso: opts.toIso,
      bin: this.deps.gwsBin,
      account: this.deps.account,
    });
  }

  private async resolve(read: CalendarReadResult): Promise<AlertPlanItem[]> {
    const seriesIds = [...new Set(read.events.map((e) => e.seriesId))];
    const overrides = await this.deps.overrides.getMany(seriesIds);
    return resolveAlertPlan({ events: read.events, overrides, model: this.deps.model });
  }

  /** Full-day plan for `dateIso` (default: today in the configured zone). */
  async planForDate(dateIso?: string): Promise<DayPlan> {
    const date = dateIso ?? todayIsoInTz(this.deps.timeZone);
    const window = zonedDayWindow(date, this.deps.timeZone);
    const read = await this.fetch(window);
    const items = await this.resolve(read);
    return { dateIso: date, items, calendarError: read.error };
  }

  /** Rolling-window plan for the alert cycle (near-term events only). */
  async planForWindow(fromIso: string, toIso: string): Promise<DayPlan> {
    const read = await this.fetch({ fromIso, toIso });
    const items = await this.resolve(read);
    return { dateIso: todayIsoInTz(this.deps.timeZone), items, calendarError: read.error };
  }
}
