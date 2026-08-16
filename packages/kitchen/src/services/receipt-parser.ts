/**
 * Receipt parser: one call over receipt photo(s) → {store, lines[]}. It sends
 * images, but the job is mechanical transcription of a structured document
 * rather than open-ended visual judgment, so it runs on the `extract` tier —
 * the cheap tier, which is what specs/modules/kitchen.md § Model tiering asks
 * for. Same tagged-JSON shape as the estimator, so any vision-capable model
 * the tier resolves to works.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { InvokeContentBlock, ModelInvoker } from '@jarvus/claude-assist-core';
import type { InventoryPhotoPart, ParsedReceipt, ParsedReceiptLine } from '../inventory-types.js';

class ReceiptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptParseError';
  }
}

export interface ReceiptParserConfig {
  /** The single metered-model choke point (specs/modules/invoker.md). */
  invoker: ModelInvoker;
  /** Pin a model for this call site. Prefer moving the tier instead. */
  model?: string;
  maxTokens?: number;
}

export interface ReceiptParseInput {
  photos: InventoryPhotoPart[];
  /** Store hint from the receipt POST (when the client already knows it). */
  storeHint?: string | null;
  /**
   * Every store already known to this instance. The model resolves the receipt
   * against this roster and returns an EXISTING name when it is the same store
   * (§ Receipt-line matching: store identity is resolved by model).
   *
   * Must be passed in FULL. A truncated roster makes a match impossible to find
   * and invites the model to mint a duplicate store, which is the exact
   * fragmentation the roster exists to prevent.
   */
  knownStores?: string[];
}

/** The pipeline depends on this narrow interface; tests inject a fake. */
export interface ReceiptParser {
  parse(input: ReceiptParseInput): Promise<ParsedReceipt>;
}

const SYSTEM_PROMPT = `<role>
You transcribe a grocery/store receipt photo into its purchased line items for a personal kitchen inventory. You do exact transcription, not interpretation — copy each product line's text as printed, mangled abbreviations and all.
</role>

<instructions>
1. STORE: Identify the merchant, then resolve it against <known_stores> if that list is provided.
   a. Read the merchant name from the receipt header — the logo or first header line — trimmed to just the brand. DROP the street address, city/state/ZIP, phone number, store number (e.g. "#1234"), slogan, and website. A <store_hint>, when present, is an operator-supplied name for the SAME store and is authoritative about WHICH merchant it is.
   b. If <known_stores> contains an entry that is THE SAME MERCHANT — including when the receipt prints a longer or shorter form of it, or different casing — return that entry EXACTLY AS LISTED. Matching an existing entry is strongly preferred: a duplicate entry for one store silently splits its purchase history.
   c. Only when no entry is the same merchant, return a new short, stable name in the receipt's printed casing.
   d. BE PRECISE ABOUT WHAT "SAME MERCHANT" MEANS. Sharing a word is not enough. A standalone market and a supermarket chain whose name happens to contain "market" are DIFFERENT merchants. A chain's small-format store (e.g. "<Chain> <Format> Market") is a DIFFERENT merchant from the full-size "<Chain>". When genuinely unsure, return the new name rather than collapsing two merchants into one — a split history is recoverable, a merged one is not.
   e. Return null if no store name is discernible and no hint is given.
2. LINES: List every purchased PRODUCT line, in order. Copy the printed item text verbatim (keep the store's abbreviations/truncations — they are the lexicon key).
3. QUANTITY: When a line represents more than one physical unit — a "N @ price" marker line above/beside the item, a "N x" prefix, or a quantity column — set that line's "quantity" to N (an integer ≥ 1) and DO NOT emit the bare "N @ price" marker as its own line. Default quantity is 1; omit it or use 1 for single units.
4. PRICE: Set each line's "price_cents" to the line's PRINTED EXTENDED price — the amount actually paid for that line's units, exactly as printed, converted to integer cents (e.g. "$7.98" -> 798). For a multi-unit line this is the printed line total, NOT the per-unit price from a "N @ price" marker. Transcribe only; never compute a price from quantity × unit price yourself. Null when the price is unreadable or the line prints none.
5. TOTAL: Set "total_cents" to the receipt's printed grand TOTAL (the final amount charged), as printed, in integer cents. Null if unreadable.
6. NON-FOOD: Set "non_food": true ONLY when a line is CLEARLY non-food — a receipt non-grocery/taxable marker (e.g. a trailing tax-class code the receipt uses for non-food) or unambiguous non-grocery text (e.g. GIFT CARD, BAG FEE, housewares like a mug or foil). Be CONSERVATIVE: if you are at all unsure whether a line is food, leave non_food false/omitted — a wrongly skipped grocery is worse than an extra question.
7. Skip non-product lines entirely: subtotals, tax, totals, payment, change, loyalty/points, store address, phone, date, cashier, standalone coupons. (The grand total is captured ONLY in "total_cents", never as a line.)
8. Do not invent items, quantities, or prices. If a product line is unreadable, skip it.
9. SELF-CHECK against the total: before answering, roughly sum your lines' price_cents and compare to total_cents. If the sum is materially off (beyond a plausible tax/deposit/discount margin), RE-EXAMINE the photos — the usual culprits are: emitting both a "N @ price" marker AND its item line, capturing a unit price where the extended price was printed, or a missed/duplicated line. Fix only what a re-read of the photos shows. NEVER adjust any number just to make the sum match — every value must be a number physically printed on the receipt; a residual mismatch is fine and expected (tax/discounts).
</instructions>

<response_format>
Return ONLY a JSON object inside <receipt> tags. No markdown, no text outside the tags.

<receipt>
{
  "store": "store name or null",
  "total_cents": 0,
  "lines": [
    {"text": "verbatim product line text", "quantity": 1, "price_cents": 0, "non_food": false}
  ]
}
</receipt>
</response_format>`;

/** Exported for prompt-contract tests (§ Prices — transcribe + self-check rules). */
export const SYSTEM_PROMPT_TEXT = SYSTEM_PROMPT;

export class KitchenReceiptParser implements ReceiptParser {
  private invoker: ModelInvoker;
  private model: string | undefined;
  private maxTokens: number;
  private log: FastifyBaseLogger;

  constructor(config: ReceiptParserConfig, log: FastifyBaseLogger) {
    this.invoker = config.invoker;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 2048;
    this.log = log;
  }

  async parse(input: ReceiptParseInput): Promise<ParsedReceipt> {
    if (input.photos.length === 0) {
      throw new ReceiptParseError('No receipt photos supplied');
    }
    const content: InvokeContentBlock[] = input.photos.map((photo) => ({
      type: 'image' as const,
      data: photo.data.toString('base64'),
      mediaType: photo.mimeType,
    }));
    content.push({
      type: 'text',
      text:
        `<receipt_photos count="${input.photos.length}"/>` +
        (input.storeHint ? `\n<store_hint>${input.storeHint}</store_hint>` : '') +
        (input.knownStores?.length
          ? `\n<known_stores>\n${input.knownStores.map((n) => `- ${n}`).join('\n')}\n</known_stores>`
          : ''),
    });

    // Tag extraction, the correction turn, retries, timeouts, and spend
    // accounting live in the invoker; the prompt and the shape validation are
    // this module's own judgment and stay here.
    return this.invoker.invokeTagged<ParsedReceipt>({
      task: 'kitchen.receipt',
      tier: 'extract',
      maxTokens: this.maxTokens,
      ...(this.model ? { model: this.model } : {}),
      system: SYSTEM_PROMPT,
      tag: 'receipt',
      parse: (raw) => this.parseReceipt(raw, input.storeHint ?? null),
      messages: [{ role: 'user', content }],
    });
  }

  /** Receives the contents of the `<receipt>` block; the invoker extracts it. */
  private parseReceipt(text: string, storeHint: string | null): ParsedReceipt {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text.trim());
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
          return {
            text,
            quantity: normalizeQuantity(obj.quantity),
            price_cents: normalizeCents(obj.price_cents),
            non_food: obj.non_food === true,
          };
        }
        return null;
      })
      .filter((l): l is ParsedReceiptLine => l !== null);
    return { store, total_cents: normalizeCents(parsed.total_cents), lines };
  }
}

/** Integer cents ≥ 0, or null on anything invalid — unreadable is null, never 0. */
function normalizeCents(value: unknown): number | null {
  const n = typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
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
