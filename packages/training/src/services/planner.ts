/**
 * The weekly synthesis — the module's one metered model call.
 *
 * Routed through `fastify.invoker` like every other metered call in the host
 * (specs/modules/invoker.md); the tier is `synthesize` because laying out a
 * training week against competing constraints is judgment work, not extraction.
 *
 * There is deliberately NO deterministic fallback plan. A meeting prep can
 * degrade to a mechanical assembly and still be useful; a training week that
 * nobody reasoned about is worse than no week at all, because it would be
 * proposed for approval as though it had been. A failure here fails the run,
 * the heartbeat is not beaten, and staleness pages.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { ModelInvoker } from '@jarvus/claude-assist-core';
import type { PlanInputs, SynthesizedWeek } from '../types.js';
import { PLAN_TAG, SYSTEM_PROMPT, buildPlanPrompt, parseWeek } from '../compose.js';

export const PLAN_TASK = 'training.weekly-plan';

export interface WeekPlanner {
  synthesize(inputs: PlanInputs): Promise<SynthesizedWeek>;
  readonly modelId: string;
}

export interface PlannerConfig {
  invoker: ModelInvoker;
  /** Pin a model, overriding the `synthesize` tier. */
  model?: string;
  maxTokens?: number;
  /** Instance config: what the owner is training for, in free text. */
  goalContext?: string;
}

export class ModelWeekPlanner implements WeekPlanner {
  readonly modelId: string;
  private readonly maxTokens: number;

  constructor(
    private readonly config: PlannerConfig,
    private readonly log: FastifyBaseLogger
  ) {
    this.modelId = config.model ?? config.invoker.modelFor('synthesize');
    this.maxTokens = config.maxTokens ?? 3000;
  }

  async synthesize(inputs: PlanInputs): Promise<SynthesizedWeek> {
    this.log.info({ weekStart: inputs.weekStart }, 'Training: synthesizing the week');
    return this.config.invoker.invokeTagged<SynthesizedWeek>({
      task: PLAN_TASK,
      tier: 'synthesize',
      maxTokens: this.maxTokens,
      ...(this.config.model ? { model: this.config.model } : {}),
      system: SYSTEM_PROMPT,
      // The system prompt is long, static, and hit once a week — well under the
      // frequency where an explicit cache breakpoint pays for itself.
      messages: [
        {
          role: 'user',
          content: buildPlanPrompt(inputs, {
            ...(this.config.goalContext ? { goalContext: this.config.goalContext } : {}),
          }),
        },
      ],
      tag: PLAN_TAG,
      parse: (raw) => parseWeek(raw, inputs.weekStart),
    });
  }
}
