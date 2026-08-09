/**
 * The provider seam.
 *
 * The invoker talks to this interface, not to the SDK directly, for two
 * reasons: the tests exercise the whole retry / parse / accounting path
 * without a network or a key, and a provider-shape change lands in this one
 * adapter rather than in the invoker's logic.
 */

import Anthropic from '@anthropic-ai/sdk';

export interface ProviderTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ProviderImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export type ProviderContentBlock = ProviderTextBlock | ProviderImageBlock;

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string | ProviderContentBlock[];
}

export interface ProviderRequest {
  model: string;
  max_tokens: number;
  system?: string | ProviderTextBlock[];
  messages: ProviderMessage[];
}

export interface ProviderResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

export interface MessagesClient {
  create(request: ProviderRequest, options: { timeoutMs: number }): Promise<ProviderResponse>;
}

/**
 * Adapter over the official SDK.
 *
 * `maxRetries: 0` is deliberate: the invoker owns the retry policy so that
 * every attempt is classified, backed off explicitly, and lands in the spend
 * ledger. The SDK's own two silent retries would be invisible in both.
 */
export function createAnthropicClient(apiKey: string): MessagesClient {
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  return {
    async create(request, options) {
      const response = await client.messages.create(
        request as never,
        { timeout: options.timeoutMs },
      );
      return response as unknown as ProviderResponse;
    },
  };
}

const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Map a declared media type onto one the provider accepts.
 *
 * Three packages each carried a copy of this; they now share it. `jpg` is the
 * common real-world input that isn't a valid media type, and an unknown type
 * falls back to jpeg rather than failing — a photo pipeline that rejects an
 * image because a phone labeled it oddly is worse than one that guesses.
 */
export function normalizeMediaType(mediaType: string | undefined): string {
  if (!mediaType) return 'image/jpeg';
  const lower = mediaType.toLowerCase().trim();
  if (IMAGE_MEDIA_TYPES.has(lower)) return lower;
  if (lower === 'image/jpg' || lower === 'jpg' || lower === 'jpeg') return 'image/jpeg';
  if (lower === 'png') return 'image/png';
  if (lower === 'gif') return 'image/gif';
  if (lower === 'webp') return 'image/webp';
  return 'image/jpeg';
}
