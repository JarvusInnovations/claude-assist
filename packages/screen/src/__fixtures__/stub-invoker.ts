/** A ModelInvoker stub that records every request and answers with fixed text (or throws). */

import type { InvokeRequest, InvokeResult, ModelInvoker } from '@jarvus/claude-assist-core';

export function stubInvoker(answer: string | (() => never)): { invoker: ModelInvoker; calls: InvokeRequest[] } {
  const calls: InvokeRequest[] = [];
  const invoker: ModelInvoker = {
    enabled: true,
    async invoke(request: InvokeRequest): Promise<InvokeResult> {
      calls.push(request);
      if (typeof answer === 'function') answer();
      return {
        text: answer as string,
        model: 'stub-model',
        tier: request.tier,
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0.000035 },
        attempts: 1,
        durationMs: 12,
      };
    },
    async invokeTagged() {
      throw new Error('the screen must not use invokeTagged (it would add a correction turn)');
    },
    modelFor: () => 'stub-model',
    spend: async () => {
      throw new Error('unused');
    },
  };
  return { invoker, calls };
}
