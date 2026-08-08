/**
 * The tier -> model map and the price table.
 *
 * **This file is the only place a model id is written.** A call site names a
 * tier describing the shape of its work; the mapping from tier to model moves
 * here, once, for everyone. Before this, fifteen call sites each carried their
 * own literal and six of them had no environment override at all.
 */

import type { ModelTier } from '@jarvus/claude-assist-core';

/**
 * Tier defaults.
 *
 * `classify` and `extract` share the cheapest adequate model today; they stay
 * separate tiers because the *jobs* differ — a long-input extraction is the
 * first thing that would want a bigger model, and separating them now means
 * that change is one line here rather than an audit of every call site.
 */
export const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  classify: 'claude-haiku-4-5',
  extract: 'claude-haiku-4-5',
  vision: 'claude-fable-5',
  synthesize: 'claude-sonnet-5',
};

/** Per-tier default wall-clock timeout. A hung classify must not hold a slot. */
export const DEFAULT_TIER_TIMEOUTS_MS: Record<ModelTier, number> = {
  classify: 60_000,
  extract: 120_000,
  vision: 180_000,
  synthesize: 300_000,
};

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million tokens written to cache. Defaults to 1.25x input. */
  cacheWrite?: number;
  /** USD per million tokens read from cache. Defaults to 0.1x input. */
  cacheRead?: number;
}

/**
 * USD per million tokens, as published.
 *
 * A price table in code goes stale on a provider revision — accepted, and the
 * reason it is overridable by config. A stale estimate is incomparably better
 * than the previous state of the world, which measured nothing at all.
 *
 * Cache multipliers follow the published ratios: a write costs 1.25x input at
 * the default 5-minute TTL, a read costs 0.1x input.
 */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-fable-5': { input: 10.0, output: 50.0 },
};

/**
 * Smallest system prompt worth a cache breakpoint, in characters.
 *
 * The provider's minimum cacheable prefix is model-dependent and is measured
 * in tokens; below it a breakpoint is silently ignored, costing the write
 * premium for nothing. This is a conservative character-count floor over the
 * largest current minimum (~4k tokens), so `cacheSystem` never asks for a
 * breakpoint that can't be honored. It is deliberately generous — a missed
 * cache is cheap, a silently-wasted write premium on every classify call is
 * not.
 */
export const MIN_CACHEABLE_SYSTEM_CHARS = 16_000;

export function resolveTierModels(
  overrides?: Partial<Record<ModelTier, string>>,
): Record<ModelTier, string> {
  return { ...DEFAULT_TIER_MODELS, ...(overrides ?? {}) };
}

export function resolvePrices(overrides?: Record<string, ModelPrice>): Record<string, ModelPrice> {
  return { ...DEFAULT_PRICES, ...(overrides ?? {}) };
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Estimated cost in **micro-dollars** (1e-6 USD).
 *
 * Integer micros rather than floats: a classify call can cost a few
 * hundred-thousandths of a dollar, and summing thousands of floats that small
 * accumulates error in exactly the column an operator is trying to trust.
 */
export function estimateCostMicros(
  model: string,
  usage: TokenCounts,
  prices: Record<string, ModelPrice>,
): number {
  const price = prices[model];
  // An unpriced model is recorded at zero rather than guessed at. The row
  // still lands, so the gap is visible as "calls with no cost" rather than as
  // an invented number.
  if (!price) return 0;

  const cacheWrite = price.cacheWrite ?? price.input * 1.25;
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  const perToken = (usdPerMillion: number, tokens: number) => (usdPerMillion * tokens) / 1_000_000;

  const usd =
    perToken(price.input, usage.inputTokens) +
    perToken(price.output, usage.outputTokens) +
    perToken(cacheWrite, usage.cacheCreationTokens) +
    perToken(cacheRead, usage.cacheReadTokens);

  return Math.round(usd * 1_000_000);
}
