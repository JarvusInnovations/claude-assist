/**
 * Receipt parser: one cheap-model vision call over receipt photo(s) →
 * {store, lines[]}. Mechanical OCR-ish extraction, so it runs on the cheap
 * tier (KITCHEN_RECEIPT_MODEL, default a Haiku-class id) per
 * specs/modules/kitchen.md § Model tiering. Mirrors the estimator's
 * XML-tagged-JSON + one-retry shape so any vision-capable model works.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { FastifyBaseLogger } from 'fastify';
import type { InventoryPhotoPart, ParsedReceipt } from '../inventory-types.js';

class ReceiptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptParseError';
  }
}

export interface ReceiptParserConfig {
  apiKey: string;
  /** default: claude-haiku-4-5 — the cheap tier for mechanical extraction. */
  model?: string;
  maxTokens?: number;
}

export interface ReceiptParseInput {
  photos: InventoryPhotoPart[];
  /** Store hint from the receipt POST (when the client already knows it). */
  storeHint?: string | null;
}

/** The pipeline depends on this narrow interface; tests inject a fake. */
export interface ReceiptParser {
  parse(input: ReceiptParseInput): Promise<ParsedReceipt>;
}

const SYSTEM_PROMPT = `<role>
You transcribe a grocery/store receipt photo into its purchased line items for a personal kitchen inventory. You do exact transcription, not interpretation — copy each product line's text as printed, mangled abbreviations and all.
</role>

<instructions>
1. Read the receipt photo(s). Identify the store name if printed.
2. List every purchased PRODUCT line, in order. Copy the printed item text verbatim (keep the store's abbreviations/truncations — they are the lexicon key).
3. Skip non-product lines: subtotals, tax, totals, payment, change, loyalty/points, store address, phone, date, cashier, coupons that aren't items.
4. Do not invent items, quantities, or prices. If a line is unreadable, skip it.
</instructions>

<response_format>
Return ONLY a JSON object inside <receipt> tags. No markdown, no text outside the tags.

<receipt>
{
  "store": "store name or null",
  "lines": [
    {"text": "verbatim product line text"}
  ]
}
</receipt>
</response_format>`;

export class KitchenReceiptParser implements ReceiptParser {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private log: FastifyBaseLogger;

  constructor(config: ReceiptParserConfig, log: FastifyBaseLogger) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model ?? 'claude-haiku-4-5';
    this.maxTokens = config.maxTokens ?? 2048;
    this.log = log;
  }

  async parse(input: ReceiptParseInput): Promise<ParsedReceipt> {
    if (input.photos.length === 0) {
      throw new ReceiptParseError('No receipt photos supplied');
    }
    const content: Anthropic.ContentBlockParam[] = input.photos.map((photo) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: normalizeMediaType(photo.mimeType),
        data: photo.data.toString('base64'),
      },
    }));
    content.push({
      type: 'text',
      text: `<receipt_photos count="${input.photos.length}"/>${
        input.storeHint ? `\n<store_hint>${input.storeHint}</store_hint>` : ''
      }`,
    });

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content }];
    const maxRetries = 1;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        messages,
      });
      const textContent = response.content.find((c) => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        if (response.stop_reason === 'refusal') throw new Error('Receipt parse refused by the model');
        throw new Error('No text response from receipt parser');
      }
      messages.push({ role: 'assistant', content: textContent.text });
      try {
        return this.parseReceipt(textContent.text, input.storeHint ?? null);
      } catch (error) {
        if (attempt < maxRetries && error instanceof ReceiptParseError) {
          this.log.warn({ attempt, error: error.message }, 'Receipt parse failed, requesting correction');
          messages.push({
            role: 'user',
            content: `<error>Parse failed: ${error.message}</error>\n\nReturn the corrected JSON inside <receipt> tags.`,
          });
        } else {
          throw error;
        }
      }
    }
    throw new Error('Unexpected: receipt parser retry loop exited without result');
  }

  private parseReceipt(text: string, storeHint: string | null): ParsedReceipt {
    const match = text.match(/<receipt>\s*([\s\S]*?)\s*<\/receipt>/);
    if (!match) throw new ReceiptParseError('No <receipt> tags found in response');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(match[1]!.trim());
    } catch (error) {
      throw new ReceiptParseError(`JSON parse error: ${error instanceof Error ? error.message : String(error)}`);
    }
    const store =
      typeof parsed.store === 'string' && parsed.store.trim() ? parsed.store.trim() : storeHint;
    const rawLines = Array.isArray(parsed.lines) ? parsed.lines : [];
    const lines = rawLines
      .map((l) => {
        if (typeof l === 'string') return { text: l.trim() };
        if (l && typeof l === 'object' && typeof (l as Record<string, unknown>).text === 'string') {
          return { text: ((l as Record<string, unknown>).text as string).trim() };
        }
        return null;
      })
      .filter((l): l is { text: string } => l !== null && l.text.length > 0);
    return { store: store ?? null, lines };
  }
}

type SupportedMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function normalizeMediaType(mimeType: string): SupportedMediaType {
  const allowed: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  return (allowed.includes(mimeType) ? mimeType : 'image/jpeg') as SupportedMediaType;
}
