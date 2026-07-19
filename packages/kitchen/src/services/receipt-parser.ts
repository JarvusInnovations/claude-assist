/**
 * Receipt parser: one cheap-model vision call over receipt photo(s) →
 * {store, lines[]}. Mechanical OCR-ish extraction, so it runs on the cheap
 * tier (KITCHEN_RECEIPT_MODEL, default a Haiku-class id) per
 * specs/modules/kitchen.md § Model tiering. Mirrors the estimator's
 * XML-tagged-JSON + one-retry shape so any vision-capable model works.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { FastifyBaseLogger } from 'fastify';
import type { InventoryPhotoPart, ParsedReceipt, ParsedReceiptLine } from '../inventory-types.js';

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
1. STORE: Return the merchant name printed in the receipt header — the logo or first header line — trimmed to just the brand. DROP the street address, city/state/ZIP, phone number, store number (e.g. "#1234"), slogan, and website; KEEP the printed casing. The goal is a short, stable name that will be identical across receipts from the same store. Return null if no store name is discernible.
2. LINES: List every purchased PRODUCT line, in order. Copy the printed item text verbatim (keep the store's abbreviations/truncations — they are the lexicon key).
3. QUANTITY: When a line represents more than one physical unit — a "N @ price" marker line above/beside the item, a "N x" prefix, or a quantity column — set that line's "quantity" to N (an integer ≥ 1) and DO NOT emit the bare "N @ price" marker as its own line. Default quantity is 1; omit it or use 1 for single units.
4. NON-FOOD: Set "non_food": true ONLY when a line is CLEARLY non-food — a receipt non-grocery/taxable marker (e.g. a trailing tax-class code the receipt uses for non-food) or unambiguous non-grocery text (e.g. GIFT CARD, BAG FEE, housewares like a mug or foil). Be CONSERVATIVE: if you are at all unsure whether a line is food, leave non_food false/omitted — a wrongly skipped grocery is worse than an extra question.
5. Skip non-product lines entirely: subtotals, tax, totals, payment, change, loyalty/points, store address, phone, date, cashier, standalone coupons.
6. Do not invent items, quantities, or prices. If a product line is unreadable, skip it.
</instructions>

<response_format>
Return ONLY a JSON object inside <receipt> tags. No markdown, no text outside the tags.

<receipt>
{
  "store": "store name or null",
  "lines": [
    {"text": "verbatim product line text", "quantity": 1, "non_food": false}
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
    // Extraction result; the pipeline applies meta-store precedence over this.
    // storeHint is the pipeline's meta store — used only as a fallback here.
    const store = normalizeStore(parsed.store) ?? (storeHint ? normalizeStore(storeHint) : null);
    const rawLines = Array.isArray(parsed.lines) ? parsed.lines : [];
    const lines = rawLines
      .map((l): ParsedReceiptLine | null => {
        if (typeof l === 'string') {
          const text = l.trim();
          return text ? { text } : null;
        }
        if (l && typeof l === 'object' && typeof (l as Record<string, unknown>).text === 'string') {
          const obj = l as Record<string, unknown>;
          const text = (obj.text as string).trim();
          if (!text) return null;
          return { text, quantity: normalizeQuantity(obj.quantity), non_food: obj.non_food === true };
        }
        return null;
      })
      .filter((l): l is ParsedReceiptLine => l !== null);
    return { store, lines };
  }
}

/**
 * Normalize a merchant name to a short, stable lexicon key: trim, collapse
 * internal whitespace runs, keep the printed casing. Null/empty → null. The
 * model does the semantic trimming (address/phone/store-number removal); this
 * is the mechanical cleanup.
 */
export function normalizeStore(store: unknown): string | null {
  if (typeof store !== 'string') return null;
  const cleaned = store.trim().replace(/\s+/g, ' ');
  return cleaned.length > 0 ? cleaned : null;
}

/** Clamp a parsed quantity to an integer ≥ 1 (default 1 on anything invalid). */
function normalizeQuantity(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

type SupportedMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function normalizeMediaType(mimeType: string): SupportedMediaType {
  const allowed: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  return (allowed.includes(mimeType) ? mimeType : 'image/jpeg') as SupportedMediaType;
}
