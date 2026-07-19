/**
 * Label parser: one vision call over a package's nutrition/size panel →
 * product facts (name, shelf-life class, package size, per-100g nutrition,
 * aliases). Reading a panel accurately earns the strong tier, so it reuses
 * KITCHEN_ESTIMATION_MODEL (specs/modules/kitchen.md § Model tiering). Same
 * XML-tagged-JSON + one-retry shape as the estimator.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { FastifyBaseLogger } from 'fastify';
import type { InventoryPhotoPart, ParsedLabel, ShelfLifeClass } from '../inventory-types.js';
import { SHELF_LIFE_CLASSES } from '../inventory-types.js';

class LabelParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabelParseError';
  }
}

export interface LabelParserConfig {
  apiKey: string;
  /** default: claude-fable-5 — the strong vision tier (reads panels accurately). */
  model?: string;
  maxTokens?: number;
}

export interface LabelParseInput {
  photos: InventoryPhotoPart[];
  /** The receipt line text / current raw label, to help name the product. */
  hint?: string | null;
}

/** The pipeline depends on this narrow interface; tests inject a fake. */
export interface LabelParser {
  parse(input: LabelParseInput): Promise<ParsedLabel>;
}

const SYSTEM_PROMPT = `<role>
You read photos of a food package's label — nutrition facts panel, ingredients list, product name, net weight/count — for a personal kitchen inventory. You extract durable product facts, not a meal estimate.
</role>

<multiple_photos>
When several photos are supplied they are complementary views of ONE product, not different products — e.g. the front of the package (for the product name, brand, and net weight), the nutrition-facts panel (for per-100g nutrition), and the ingredients panel (for the ingredients list). Combine them into a single extraction: take identity/size from the front, nutrition from the nutrition panel, ingredients from the ingredients panel. Never merge distinct products; if the photos plainly show different products, describe the most prominent one.
</multiple_photos>

<instructions>
1. Read the product's display name (brand + item, e.g. "Store-brand Feta Cheese").
2. Classify its shelf-life into exactly one class:
   - pantry: shelf-stable dry/canned goods (rice, pasta, canned beans, oil).
   - frozen: sold/kept frozen.
   - fridge_long: refrigerated but long-lived (hard cheese, condiments, eggs, butter).
   - fridge_short: refrigerated and perishable (milk, yogurt, deli, soft cheese, tofu).
   - produce: fresh fruit/vegetables.
   - very_perishable: fish, fresh berries, fresh herbs, prepared salads.
   - unknown: cannot tell.
3. Read the package size as printed (e.g. "16 oz", "1 L", "12 ct"). Null if absent.
4. If a nutrition facts panel is visible, give per-100g values (calories, protein_g, fat_g, sat_fat_g, carbs_g, sodium_mg, fiber_g, sugar_g). Convert from the panel's serving size to 100g. Any single value you cannot read is null; a partial panel fills what it shows and leaves the rest null.
5. If an ingredients list is visible, transcribe it verbatim as printed (a single comma-separated string). Null if no ingredients panel is shown.
6. Suggest up to 3 short alias strings someone might use when logging (e.g. "feta", "feta cheese").
</instructions>

<response_format>
Return ONLY a JSON object inside <label> tags. No markdown, no text outside the tags.

<label>
{
  "name": "product display name or null",
  "shelf_life_class": "pantry|frozen|fridge_long|fridge_short|produce|very_perishable|unknown",
  "package_size": "as printed or null",
  "nutrition_per_100g": {"calories": 0, "protein_g": 0, "fat_g": 0, "sat_fat_g": 0, "carbs_g": 0, "sodium_mg": 0, "fiber_g": 0, "sugar_g": 0},
  "ingredients": "ingredients list as printed, or null",
  "aliases": ["short", "names"]
}
</label>

Any value you cannot read should be null (nutrition_per_100g itself may be null if no panel is visible; ingredients null if no ingredients panel is visible).
</response_format>`;

export class KitchenLabelParser implements LabelParser {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private log: FastifyBaseLogger;

  constructor(config: LabelParserConfig, log: FastifyBaseLogger) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model ?? 'claude-fable-5';
    this.maxTokens = config.maxTokens ?? 1024;
    this.log = log;
  }

  async parse(input: LabelParseInput): Promise<ParsedLabel> {
    if (input.photos.length === 0) throw new LabelParseError('No label photos supplied');
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
      text: `<label_photos count="${input.photos.length}"/>${
        input.hint ? `\n<receipt_text>${input.hint}</receipt_text>` : ''
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
        if (response.stop_reason === 'refusal') throw new Error('Label parse refused by the model');
        throw new Error('No text response from label parser');
      }
      messages.push({ role: 'assistant', content: textContent.text });
      try {
        return this.parseLabel(textContent.text);
      } catch (error) {
        if (attempt < maxRetries && error instanceof LabelParseError) {
          this.log.warn({ attempt, error: error.message }, 'Label parse failed, requesting correction');
          messages.push({
            role: 'user',
            content: `<error>Parse failed: ${error.message}</error>\n\nReturn the corrected JSON inside <label> tags.`,
          });
        } else {
          throw error;
        }
      }
    }
    throw new Error('Unexpected: label parser retry loop exited without result');
  }

  private parseLabel(text: string): ParsedLabel {
    const match = text.match(/<label>\s*([\s\S]*?)\s*<\/label>/);
    if (!match) throw new LabelParseError('No <label> tags found in response');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(match[1]!.trim());
    } catch (error) {
      throw new LabelParseError(`JSON parse error: ${error instanceof Error ? error.message : String(error)}`);
    }

    const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null;
    const cls = SHELF_LIFE_CLASSES.includes(parsed.shelf_life_class as ShelfLifeClass)
      ? (parsed.shelf_life_class as ShelfLifeClass)
      : null;
    const packageSize =
      typeof parsed.package_size === 'string' && parsed.package_size.trim() ? parsed.package_size.trim() : null;

    const rawNut = parsed.nutrition_per_100g;
    const nutrition =
      rawNut && typeof rawNut === 'object'
        ? {
            calories: numOrNull((rawNut as Record<string, unknown>).calories),
            protein_g: numOrNull((rawNut as Record<string, unknown>).protein_g),
            fat_g: numOrNull((rawNut as Record<string, unknown>).fat_g),
            sat_fat_g: numOrNull((rawNut as Record<string, unknown>).sat_fat_g),
            carbs_g: numOrNull((rawNut as Record<string, unknown>).carbs_g),
            sodium_mg: numOrNull((rawNut as Record<string, unknown>).sodium_mg),
            fiber_g: numOrNull((rawNut as Record<string, unknown>).fiber_g),
            sugar_g: numOrNull((rawNut as Record<string, unknown>).sugar_g),
          }
        : null;

    const ingredients =
      typeof parsed.ingredients === 'string' && parsed.ingredients.trim() ? parsed.ingredients.trim() : null;

    const aliases = Array.isArray(parsed.aliases)
      ? parsed.aliases.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim()).slice(0, 3)
      : [];

    return { name, shelf_life_class: cls, package_size: packageSize, nutrition_per_100g: nutrition, ingredients, aliases };
  }
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

type SupportedMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function normalizeMediaType(mimeType: string): SupportedMediaType {
  const allowed: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  return (allowed.includes(mimeType) ? mimeType : 'image/jpeg') as SupportedMediaType;
}
