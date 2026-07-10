/**
 * Alert-plan resolution — the shared bridge between the classifier and both
 * consumers (the alert scheduler fires from it; the daily briefing lists it so
 * misclassifications are visible before they bite).
 *
 * For each event: apply the per-series override, run the deterministic
 * classifier, escalate the ambiguous residue to the model when one is wired
 * (else keep the conservative deterministic default), then compute the lead
 * time + fire-at instant for anything join-required.
 */

import type { AlertPlanItem, CalendarEvent, SeriesOverride } from '../types.js';
import { classifyEvent, isAmbiguous, leadMinutesFor } from '../classifier/join-required.js';
import type { JoinRequiredModel } from '../classifier/llm.js';

export interface ResolvePlanDeps {
  events: CalendarEvent[];
  overrides: Map<string, SeriesOverride>;
  /** Optional Haiku residue pass; without it, ambiguous stays non-join. */
  model?: JoinRequiredModel | null;
}

/** Fire-at instant (epoch ms) for a join-required event, or null if unschedulable. */
export function computeFireAtMs(startMs: number | null, leadMinutes: number): number | null {
  if (startMs == null) return null;
  return startMs - leadMinutes * 60_000;
}

export async function resolveAlertPlan(deps: ResolvePlanDeps): Promise<AlertPlanItem[]> {
  const { events, overrides, model } = deps;
  const items: AlertPlanItem[] = [];

  for (const event of events) {
    const override = overrides.get(event.seriesId) ?? null;
    let classification = classifyEvent(event, override);

    if (isAmbiguous(classification) && model) {
      try {
        classification = await model.classify(event, classification.venue);
      } catch {
        // Model failure keeps the conservative deterministic default (no fire);
        // the item still surfaces in the briefing as a near-miss.
      }
    }

    if (!classification.joinRequired) {
      items.push({ event, classification, leadMinutes: null, fireAtMs: null });
      continue;
    }

    const leadMinutes = leadMinutesFor(classification, override);
    items.push({
      event,
      classification,
      leadMinutes,
      fireAtMs: computeFireAtMs(event.startMs, leadMinutes),
    });
  }

  return items;
}

/** The join-required subset of a plan, in fire order. */
export function alertingItems(plan: AlertPlanItem[]): AlertPlanItem[] {
  return plan
    .filter((item) => item.classification.joinRequired && item.fireAtMs != null)
    .sort((a, b) => (a.fireAtMs ?? 0) - (b.fireAtMs ?? 0));
}
