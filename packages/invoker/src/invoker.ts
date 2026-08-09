/**
 * The single choke point for metered model calls. See `specs/modules/invoker.md`.
 */

import type { FastifyBaseLogger } from 'fastify';
import {
  ModelInvocationError,
  type ApprovalService,
  type InvokeContentBlock,
  type InvokeMessage,
  type InvokeRequest,
  type InvokeResult,
  type ModelInvoker,
  type ModelTier,
  type SpendSnapshot,
  type TaggedInvokeRequest,
} from '@jarvus/claude-assist-core';
import {
  DEFAULT_TIER_TIMEOUTS_MS,
  MIN_CACHEABLE_SYSTEM_CHARS,
  estimateCostMicros,
  type ModelPrice,
} from './models.js';
import type { BudgetLimits, BudgetTracker } from './budget.js';
import type { SpendStorePort } from './store.js';
import {
  normalizeMediaType,
  type MessagesClient,
  type ProviderContentBlock,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderTextBlock,
} from './provider.js';

export interface InvokerDeps {
  log: FastifyBaseLogger;
  store: SpendStorePort;
  budget: BudgetTracker;
  limits: BudgetLimits;
  tierModels: Record<ModelTier, string>;
  prices: Record<string, ModelPrice>;
  /** Absent leaves the invoker disabled — every call fails `transient`. */
  client?: MessagesClient;
  approvals?: ApprovalService;
  killSwitch?: boolean;
  /** Transport attempts per call, including the first. Default 3. */
  maxAttempts?: number;
  /** First retry delay in ms; doubles with jitter. Default 500. */
  retryBaseMs?: number;
  /** Overrides the per-tier default timeout. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

interface ProviderFailure {
  status?: number;
  retryAfterMs?: number;
  message: string;
}

/** Read what an SDK/transport error tells us, without depending on its class. */
function readFailure(error: unknown): ProviderFailure {
  const err = error as {
    status?: number;
    message?: string;
    name?: string;
    headers?: Record<string, string> | { get?: (k: string) => string | null };
    error?: { message?: string };
  };
  const message = err?.error?.message ?? err?.message ?? String(error);

  let retryAfterMs: number | undefined;
  const headers = err?.headers;
  const raw =
    headers && typeof (headers as { get?: unknown }).get === 'function'
      ? (headers as { get: (k: string) => string | null }).get('retry-after')
      : (headers as Record<string, string> | undefined)?.['retry-after'];
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) retryAfterMs = seconds * 1000;
  }

  return {
    ...(err?.status !== undefined ? { status: err.status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    message,
  };
}

function isRetryable(failure: ProviderFailure): boolean {
  if (failure.status !== undefined) return RETRYABLE_STATUSES.has(failure.status);
  // No status means the request never got an answer — connection reset, DNS
  // blip, timeout. That is the canonical retryable case.
  return true;
}

function toProviderContent(content: string | InvokeContentBlock[]): string | ProviderContentBlock[] {
  if (typeof content === 'string') return content;
  return content.map((block): ProviderContentBlock => {
    if (block.type === 'image') {
      return {
        type: 'image',
        source: { type: 'base64', media_type: normalizeMediaType(block.mediaType), data: block.data },
      };
    }
    return { type: 'text', text: block.text };
  });
}

function toProviderMessages(messages: InvokeMessage[]): ProviderMessage[] {
  return messages.map((m) => ({ role: m.role, content: toProviderContent(m.content) }));
}

function extractText(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
    .trim();
}

/** Pull the contents of `<tag>…</tag>`, tolerating surrounding prose. */
export function extractTag(raw: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(raw);
  return match?.[1] ?? null;
}

export function createInvoker(deps: InvokerDeps): ModelInvoker {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 3);
  const retryBaseMs = deps.retryBaseMs ?? 500;
  const enabled = deps.client !== undefined;

  /** Fire-and-forget: a ledger write must never fail the caller's work. */
  function ledger(row: Parameters<SpendStorePort['record']>[0]): void {
    deps.store.record(row).catch((err) => {
      deps.log.error({ err, task: row.task }, 'Failed to record model invocation');
    });
  }

  /**
   * Raise (or consult) the human gate for a budget breach.
   *
   * Deduplicated per window per scope, so a sweep hitting the wall every
   * minute produces one notification, not sixty. An already-approved overage
   * is applied and the caller retries on its own next pass — nothing waits.
   */
  async function gateOnBudget(scope: string, detail: string): Promise<boolean> {
    if (!deps.approvals) return false;
    const snapshot = deps.budget.snapshot();
    const dedupeKey = `invoker:budget:${scope}:${snapshot.windowStart.toISOString().slice(0, 10)}`;

    const resolved = await deps.approvals.findResolved(dedupeKey);
    if (resolved?.status === 'approved') {
      const overage = Number(resolved.resolution?.params?.['overageUsd'] ?? 0);
      if (overage > 0) {
        deps.budget.grantOverage(overage);
        deps.log.warn({ scope, overage }, 'Model budget overage approved; resuming');
        return true;
      }
    }

    await deps.approvals.request({
      kind: 'model_budget_overage',
      requestedBy: 'invoker',
      title: `Model budget reached (${scope})`,
      body: `${detail} Spent $${snapshot.costUsd.toFixed(2)} across ${snapshot.calls} calls since ${snapshot.windowStart.toISOString()}. Approve with an overageUsd amount to resume for the rest of the window.`,
      payload: {
        scope,
        costUsd: snapshot.costUsd,
        tokens: snapshot.tokens,
        calls: snapshot.calls,
        windowStart: snapshot.windowStart.toISOString(),
      },
      dedupeKey,
      priority: 'notice',
    });
    return false;
  }

  async function invoke(request: InvokeRequest): Promise<InvokeResult> {
    const { task, tier } = request;

    if (!deps.client) {
      throw new ModelInvocationError('Model invoker is disabled: no API credential configured', {
        reason: 'disabled',
        task,
        transient: true,
      });
    }
    if (deps.killSwitch) {
      throw new ModelInvocationError('Model invocation is stopped by the kill switch', {
        reason: 'kill_switch',
        task,
        transient: true,
      });
    }

    let verdict = await deps.budget.check(task);
    if (!verdict.ok) {
      const scope = verdict.scope;
      const detail =
        verdict.limitUsd !== undefined
          ? `The $${verdict.limitUsd} daily ceiling for ${scope} is exhausted.`
          : `The ${verdict.limitTokens} daily token ceiling for ${scope} is exhausted.`;
      const opened = await gateOnBudget(scope, detail);
      verdict = opened ? await deps.budget.check(task) : verdict;
      if (!verdict.ok) {
        throw new ModelInvocationError(`${detail} Awaiting approval to continue.`, {
          reason: 'budget_exceeded',
          task,
          transient: true,
        });
      }
    }

    const model = request.model ?? deps.tierModels[tier];
    const timeoutMs = request.timeoutMs ?? deps.timeoutMs ?? DEFAULT_TIER_TIMEOUTS_MS[tier];

    const system: ProviderRequest['system'] =
      request.system === undefined
        ? undefined
        : request.cacheSystem && request.system.length >= MIN_CACHEABLE_SYSTEM_CHARS
          ? ([{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }] as ProviderTextBlock[])
          : request.system;

    const providerRequest: ProviderRequest = {
      model,
      max_tokens: request.maxTokens,
      ...(system === undefined ? {} : { system }),
      messages: toProviderMessages(request.messages),
    };

    let lastError: ModelInvocationError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now();
      try {
        const response = await deps.client.create(providerRequest, { timeoutMs });
        const durationMs = Date.now() - startedAt;

        const usage = {
          inputTokens: response.usage.input_tokens ?? 0,
          outputTokens: response.usage.output_tokens ?? 0,
          cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        };
        const costMicros = estimateCostMicros(model, usage, deps.prices);
        const totalTokens =
          usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;

        deps.budget.add(task, totalTokens, costMicros);
        ledger({
          task,
          tier,
          model,
          attempt,
          outcome: 'succeeded',
          stopReason: response.stop_reason,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheWriteTokens: usage.cacheCreationTokens,
          cacheReadTokens: usage.cacheReadTokens,
          costMicros,
          durationMs,
        });

        // A refusal is a terminal outcome, not a transport failure: retrying
        // the identical request produces the identical refusal and bills for
        // it again.
        if (response.stop_reason === 'refusal') {
          throw new ModelInvocationError(`Model declined the request for ${task}`, {
            reason: 'refusal',
            task,
          });
        }

        return {
          text: extractText(response),
          model,
          tier,
          stopReason: response.stop_reason,
          usage: { ...usage, costUsd: costMicros / 1_000_000 },
          attempts: attempt,
          durationMs,
        };
      } catch (error) {
        if (error instanceof ModelInvocationError) throw error;

        const durationMs = Date.now() - startedAt;
        const failure = readFailure(error);
        const retryable = isRetryable(failure);
        const reason =
          failure.status === 429
            ? 'rate_limited'
            : failure.status !== undefined && failure.status < 500 && failure.status !== 408
              ? 'invalid_request'
              : retryable
                ? 'provider_error'
                : 'timeout';

        ledger({
          task,
          tier,
          model,
          attempt,
          outcome: 'failed',
          errorReason: reason,
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          costMicros: 0,
          durationMs,
        });

        lastError = new ModelInvocationError(
          `Model call failed for ${task} (attempt ${attempt}/${maxAttempts}): ${failure.message}`,
          {
            reason,
            task,
            retryable,
            ...(failure.status !== undefined ? { status: failure.status } : {}),
            cause: error,
          },
        );

        // A terminal failure never burns a second attempt: a malformed request
        // is malformed on every try, and each try is billed.
        if (!retryable || attempt === maxAttempts) throw lastError;

        const backoff = failure.retryAfterMs ?? retryBaseMs * 2 ** (attempt - 1);
        const jitter = Math.floor(Math.random() * retryBaseMs);
        deps.log.warn(
          { task, model, attempt, status: failure.status, backoff },
          `Retrying model call for ${task}`,
        );
        await sleep(backoff + jitter);
      }
    }

    throw lastError ?? new ModelInvocationError(`Model call failed for ${task}`, {
      reason: 'provider_error',
      task,
    });
  }

  async function invokeTagged<T>(request: TaggedInvokeRequest<T>): Promise<T> {
    const { tag, parse, parseRetries = 1, ...base } = request;
    const messages: InvokeMessage[] = [...base.messages];
    let lastMessage = 'no response';

    for (let round = 0; round <= parseRetries; round++) {
      const result = await invoke({ ...base, messages });
      try {
        const inner = extractTag(result.text, tag);
        if (inner === null) throw new Error(`no <${tag}> block in the response`);
        return parse(inner);
      } catch (err) {
        lastMessage = err instanceof Error ? err.message : String(err);
        if (round === parseRetries) break;
        // The correction turn: show the model its own bad output and name the
        // problem. One retry, not five — a model that fails the shape twice
        // usually fails it every time, and every attempt is billed.
        messages.push({ role: 'assistant', content: result.text });
        messages.push({
          role: 'user',
          content: `<error>Parse failed: ${lastMessage}. Reply with a single valid <${tag}> block and nothing else.</error>`,
        });
      }
    }

    throw new ModelInvocationError(
      `Could not parse a <${tag}> block for ${request.task}: ${lastMessage}`,
      { reason: 'parse_failed', task: request.task },
    );
  }

  return {
    get enabled() {
      return enabled && !deps.killSwitch;
    },

    invoke,
    invokeTagged,

    modelFor(tier) {
      return deps.tierModels[tier];
    },

    async spend(): Promise<SpendSnapshot> {
      const snapshot = deps.budget.snapshot();
      let byTask: SpendSnapshot['byTask'] = [];
      try {
        byTask = await deps.store.taskTotalsSince(snapshot.windowStart);
      } catch (err) {
        deps.log.error({ err }, 'Failed to read per-task spend');
      }
      return {
        enabled,
        killSwitch: deps.killSwitch === true,
        windowStart: snapshot.windowStart.toISOString(),
        calls: snapshot.calls,
        tokens: snapshot.tokens,
        costUsd: snapshot.costUsd,
        budget: {
          dailyUsd: deps.limits.dailyUsd ?? null,
          dailyTokens: deps.limits.dailyTokens ?? null,
          approvedOverageUsd: snapshot.approvedOverageUsd,
        },
        byTask,
        models: { ...deps.tierModels },
      };
    },
  };
}
