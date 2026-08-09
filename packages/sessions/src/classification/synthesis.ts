/**
 * Weekly synthesis (the strong `synthesize` tier). Digests a week of
 * append-only classification events into (1) a structured report of proposed
 * memory/rule/hook/skill/spec changes + ranked friction hotspots, and (2) an
 * dev-diary-style narrative of how the assistant's system evolved that week.
 *
 * The service builds prompts + calls the model + persists; DELIVERY (the notify
 * digest) happens in the caller (the scheduler handler), matching how the rest
 * of the package beats heartbeats and dispatches from index.ts/routes.ts.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { ModelInvoker } from '@jarvus/claude-assist-core';
import type { ClassificationStore } from './store.js';
import type {
  ActiveSessionSummary,
  ClassificationEventWithContext,
  SynthesisPayload,
} from './types.js';

export interface SynthesisConfig {
  /** The single metered-model choke point (specs/modules/invoker.md). */
  invoker: ModelInvoker;
  /** Pin a model for this call site. Prefer moving the tier instead. */
  model?: string;
  maxTokens?: number;
}

/** A UTC week window [start, end) as Date bounds plus YYYY-MM-DD labels. */
export interface Period {
  start: Date;
  end: Date;
  startLabel: string;
  endLabel: string;
}

/** The most recent complete 7-day window ending at `now` (default: this instant). */
export function lastWeekPeriod(now: Date = new Date()): Period {
  const end = new Date(now);
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    start,
    end,
    startLabel: start.toISOString().slice(0, 10),
    endLabel: end.toISOString().slice(0, 10),
  };
}

function projectLabel(e: { project_path: string | null }): string {
  if (!e.project_path) return 'unknown';
  return e.project_path.split('/').filter(Boolean).pop() ?? e.project_path;
}

/** Group events by type, preserving order. Pure helper shared by both prompts. */
function byType(events: ClassificationEventWithContext[]): Map<string, ClassificationEventWithContext[]> {
  const m = new Map<string, ClassificationEventWithContext[]>();
  for (const e of events) {
    if (!m.has(e.event_type)) m.set(e.event_type, []);
    m.get(e.event_type)!.push(e);
  }
  return m;
}

const EVENT_ORDER = ['correction', 'friction', 'rule-candidate', 'notable-decision'];

/** Render the event corpus into a compact, grouped block for a prompt. Pure. */
export function renderEventCorpus(events: ClassificationEventWithContext[]): string {
  if (events.length === 0) return '(no classification events this period)';
  const grouped = byType(events);
  const parts: string[] = [];
  for (const type of EVENT_ORDER) {
    const list = grouped.get(type);
    if (!list || list.length === 0) continue;
    parts.push(`## ${type} (${list.length})`);
    for (const e of list) {
      const q = e.quote ? ` — "${e.quote}"` : '';
      parts.push(
        `- [${projectLabel(e)}] ${e.summary} (conf ${e.confidence.toFixed(2)})${q}`
      );
    }
  }
  return parts.join('\n');
}

export const SYNTHESIS_SYSTEM_PROMPT = `<role>
You run the weekly self-improvement review for the owner's personal AI assistant system. You are given a week's worth of typed signals detected across the owner's Claude Code sessions: corrections he made, friction points, rule candidates, and notable decisions. Synthesize them into concrete, reviewable proposals a human will apply. You do NOT apply anything yourself.
</role>

<instructions>
1. Weigh corrections and repeated friction most heavily — they are the strongest evidence of where the system should change.
2. Propose specific, minimal changes to the assistant's memory, rules/hooks, skills, protocols, or specs. Each proposal must trace to evidence in the corpus.
3. Rank friction hotspots by how often and how severely they recurred.
4. Be concrete. "Improve error handling" is useless; "add a hook that blocks commits when .tool-versions lacks opentofu" is actionable.
5. If the corpus is thin, say so and propose little — do not manufacture proposals.
</instructions>

<response_format>
Return TWO blocks and nothing else.

First, a human-readable markdown report inside <report> tags: a short lede, then sections for Proposed changes and Friction hotspots.

Then a structured JSON object inside <json> tags:
<json>
{
  "proposed_memory_updates": ["..."],
  "proposed_changes": [
    { "target": "rule|hook|skill|spec|protocol|memory", "summary": "...", "rationale": "..." }
  ],
  "friction_hotspots": [
    { "area": "...", "count": 0, "examples": ["..."] }
  ]
}
</json>
</response_format>`;

/** Build the weekly synthesis user prompt. Pure — unit-tested directly. */
export function buildSynthesisPrompt(
  period: Period,
  events: ClassificationEventWithContext[]
): string {
  return `<period>${period.startLabel} to ${period.endLabel}</period>
<event_count>${events.length}</event_count>
<corpus>
${renderEventCorpus(events)}
</corpus>`;
}

export const NARRATIVE_SYSTEM_PROMPT = `<role>
You write a short weekly narrative documenting how the assistant (the owner's personal AI assistant system) evolved this week — in the spirit of a "dev-diary" engineering-diary entry: a tight, readable story, not a bulleted status report. You draw on the week's classification signals and which repos/sessions were active.
</role>

<instructions>
1. Tell the story of the week: what the owner and the assistant worked on, where the system stumbled and got corrected, what durable rules or decisions emerged.
2. 150–300 words. Concrete and specific; name the repos/areas that moved. No filler, no hype.
3. This is a record for the owner to read, not a pitch. Plain, honest voice.
</instructions>

<response_format>
Return ONLY the narrative markdown inside <narrative> tags.
</narrative>`;

/** Build the weekly narrative user prompt. Pure — unit-tested directly. */
export function buildNarrativePrompt(
  period: Period,
  events: ClassificationEventWithContext[],
  activeSessions: ActiveSessionSummary[]
): string {
  const active = activeSessions.length
    ? activeSessions
        .slice(0, 25)
        .map((s) => `- [${projectLabel(s)}] ${s.title ?? s.session_name ?? s.id} (${s.event_count} signals)`)
        .join('\n')
    : '(no active sessions with signals this period)';
  return `<period>${period.startLabel} to ${period.endLabel}</period>
<active_sessions>
${active}
</active_sessions>
<corpus>
${renderEventCorpus(events)}
</corpus>`;
}

/** Extract the first XML block's inner text. */
function extractTag(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`));
  return m?.[1]?.trim() ?? null;
}

export interface SynthesisResult {
  report: string;
  payload: SynthesisPayload | null;
  eventCount: number;
}

export interface NarrativeResult {
  narrative: string;
  eventCount: number;
}

export class SynthesisService {
  private invoker: ModelInvoker;
  private pinnedModel: string | undefined;
  private maxTokens: number;
  private log: FastifyBaseLogger;

  constructor(
    private store: ClassificationStore,
    config: SynthesisConfig,
    log: FastifyBaseLogger
  ) {
    this.invoker = config.invoker;
    this.pinnedModel = config.model;
    this.maxTokens = config.maxTokens ?? 4096;
    this.log = log;
  }

  /** Which model produced a stored report — persisted with the artifact. */
  get model(): string {
    return this.pinnedModel ?? this.invoker.modelFor('synthesize');
  }

  /**
   * Plain (untagged) invocation. `invokeTagged` handles exactly one tag and
   * treats a missing one as a parse failure worth a correction turn; the
   * synthesis reply carries two blocks (`<report>` plus an optional `<json>`),
   * and both callers would rather keep an untagged reply than pay to ask
   * again. So the extraction stays here.
   */
  private async complete(task: string, system: string, user: string): Promise<string> {
    const result = await this.invoker.invoke({
      task,
      tier: 'synthesize',
      maxTokens: this.maxTokens,
      ...(this.pinnedModel ? { model: this.pinnedModel } : {}),
      system,
      messages: [{ role: 'user', content: user }],
    });
    return result.text;
  }

  /** Synthesize a period's events into a report + structured payload, and persist. */
  async synthesizeWeek(period: Period): Promise<SynthesisResult> {
    const events = await this.store.eventsForPeriod(period.start, period.end);
    const raw = await this.complete(
      'sessions.synthesis',
      SYNTHESIS_SYSTEM_PROMPT,
      buildSynthesisPrompt(period, events)
    );

    const report = extractTag(raw, 'report') ?? raw.trim();
    let payload: SynthesisPayload | null = null;
    const jsonText = extractTag(raw, 'json');
    if (jsonText) {
      try {
        payload = JSON.parse(jsonText) as SynthesisPayload;
      } catch (error) {
        this.log.warn({ error }, 'Synthesis JSON block failed to parse; storing report only');
      }
    }

    await this.store.saveReport(
      'synthesis',
      period.startLabel,
      period.endLabel,
      report,
      payload,
      events.length,
      this.model
    );

    return { report, payload, eventCount: events.length };
  }

  /** Render a period's timeline narrative and persist. */
  async narrateWeek(period: Period): Promise<NarrativeResult> {
    const [events, active] = await Promise.all([
      this.store.eventsForPeriod(period.start, period.end),
      this.store.activeSessionsForPeriod(period.start, period.end),
    ]);
    const raw = await this.complete(
      'sessions.narrative',
      NARRATIVE_SYSTEM_PROMPT,
      buildNarrativePrompt(period, events, active)
    );
    const narrative = extractTag(raw, 'narrative') ?? raw.trim();

    await this.store.saveReport(
      'narrative',
      period.startLabel,
      period.endLabel,
      narrative,
      null,
      events.length,
      this.model
    );

    return { narrative, eventCount: events.length };
  }
}
