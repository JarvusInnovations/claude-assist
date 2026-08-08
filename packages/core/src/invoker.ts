/**
 * Model-invocation contract — the single choke point for metered model calls.
 *
 * These types live in core (not in the invoker package) so every module can
 * take a `ModelInvoker` without depending on the implementation, and so a test
 * can satisfy the interface with a stub. The invoker package implements them.
 *
 * Spec: `specs/modules/invoker.md`.
 *
 * The boundary this contract defends: **metered** calls route through here.
 * Any path that warms or drives an *interactive* session a human is steering
 * runs on that human's own credentials and must never reach this interface.
 */

/**
 * The shape of the work, not the name of a model.
 *
 * Call sites name a tier; the tier -> model map inside the invoker is the only
 * place a model id is written, so the mapping moves for everyone at once.
 */
export type ModelTier = 'classify' | 'extract' | 'vision' | 'synthesize';

export const MODEL_TIERS: readonly ModelTier[] = [
  'classify',
  'extract',
  'vision',
  'synthesize',
] as const;

/** A content block — text, or an image for the vision tier. */
export type InvokeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mediaType: string };

export interface InvokeMessage {
  role: 'user' | 'assistant';
  content: string | InvokeContentBlock[];
}

export interface InvokeRequest {
  /**
   * Stable dotted id for this call site (`google.triage`, `kitchen.receipt`).
   * The grain of every spend query and per-task budget, so it must not encode
   * anything variable — no ids, no dates, no account names.
   */
  task: string;
  tier: ModelTier;
  maxTokens: number;
  system?: string;
  messages: InvokeMessage[];
  /**
   * Pin a specific model for this call, overriding the tier map. An exception
   * that has to justify itself — prefer moving the tier.
   */
  model?: string;
  /**
   * Place an explicit prompt-cache breakpoint on the system prompt. Worth it
   * for a long static preamble on a high-frequency call site; wasted on a
   * short one, where the breakpoint falls below the provider's minimum.
   */
  cacheSystem?: boolean;
  /** Wall-clock timeout for the whole call. Defaults per tier. */
  timeoutMs?: number;
}

export interface TaggedInvokeRequest<T> extends InvokeRequest {
  /** XML tag wrapping the model's structured answer (e.g. `verdict`). */
  tag: string;
  /**
   * Parse + validate the tag's contents. Throw to signal "wrong shape" — the
   * invoker appends a correction turn and asks once more.
   */
  parse: (raw: string) => T;
  /** Correction turns after a parse failure. Default 1; 0 disables. */
  parseRetries?: number;
}

export interface InvokeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Estimated, from the invoker's price table. */
  costUsd: number;
}

export interface InvokeResult {
  text: string;
  model: string;
  tier: ModelTier;
  stopReason: string | null;
  usage: InvokeUsage;
  /** Transport attempts made, including the successful one. */
  attempts: number;
  durationMs: number;
}

export type ModelFailureReason =
  | 'disabled'
  | 'kill_switch'
  | 'budget_exceeded'
  | 'timeout'
  | 'rate_limited'
  | 'provider_error'
  | 'invalid_request'
  | 'refusal'
  | 'parse_failed';

/**
 * The single error type every metered call fails with.
 *
 * `transient` is the load-bearing field: it marks failures that are the
 * *system's* fault rather than the work item's (kill switch, budget breach,
 * no credential). A pipeline must not count a transient failure against a
 * row's attempt cap, or one exhausted budget permanently poisons a backlog it
 * never got to look at.
 */
export class ModelInvocationError extends Error {
  readonly reason: ModelFailureReason;
  readonly task: string;
  /** Whether the invoker's own retry loop should try again. */
  readonly retryable: boolean;
  /** Whether the caller should decline to blame the work item. */
  readonly transient: boolean;
  readonly status?: number;

  constructor(
    message: string,
    opts: {
      reason: ModelFailureReason;
      task: string;
      retryable?: boolean;
      transient?: boolean;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ModelInvocationError';
    this.reason = opts.reason;
    this.task = opts.task;
    this.retryable = opts.retryable ?? false;
    this.transient = opts.transient ?? false;
    this.status = opts.status;
  }
}

/**
 * True when a failure is the system's fault, not the work item's.
 *
 * Pipelines that keep a per-row attempt counter guard their failure recording
 * with this, so a budget breach or a kill switch doesn't consume attempts on
 * rows the model never even saw.
 */
export function isTransientModelError(error: unknown): boolean {
  return error instanceof ModelInvocationError && error.transient;
}

export interface SpendTaskRow {
  task: string;
  calls: number;
  tokens: number;
  costUsd: number;
}

export interface SpendSnapshot {
  /** False when no API credential is configured. */
  enabled: boolean;
  killSwitch: boolean;
  /** Start of the current rolling window, ISO. */
  windowStart: string;
  calls: number;
  tokens: number;
  costUsd: number;
  budget: {
    dailyUsd: number | null;
    dailyTokens: number | null;
    /** Extra dollars a human approved for the remainder of this window. */
    approvedOverageUsd: number;
  };
  byTask: SpendTaskRow[];
  models: Record<ModelTier, string>;
}

/** The single entry point every metered model call goes through. */
export interface ModelInvoker {
  /** False when no API credential is configured — callers skip construction. */
  readonly enabled: boolean;
  invoke(request: InvokeRequest): Promise<InvokeResult>;
  /**
   * Invoke and parse a tagged structured answer, appending one correction turn
   * when the shape comes back wrong. Twelve call sites had each written this
   * loop for themselves.
   */
  invokeTagged<T>(request: TaggedInvokeRequest<T>): Promise<T>;
  /** The model a tier currently resolves to. */
  modelFor(tier: ModelTier): string;
  spend(): Promise<SpendSnapshot>;
}
