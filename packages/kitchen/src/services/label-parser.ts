/**
 * Label parser: one vision call over a package's nutrition/size panel →
 * product facts (name, shelf-life class, package size, per-100g nutrition,
 * aliases). Reading a panel accurately earns the strong tier, so it reuses
 * KITCHEN_ESTIMATION_MODEL (specs/modules/kitchen.md § Model tiering). Same
 * XML-tagged-JSON + one-retry shape as the estimator.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { FastifyBaseLogger } from 'fastify';
import type { InventoryPhotoPart, NutritionPer100g, ParsedLabel, ShelfLifeClass } from '../inventory-types.js';
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
3. Read the package size as printed (e.g. "16 oz", "1 L", "12 ct"). Null if absent. ALSO transcribe the package's printed NET CONTENT as a raw value + unit pair in "net_content" — prefer a printed metric figure when one exists (e.g. "16 oz (454g)" -> {"value": 454, "unit": "g"}; "64 fl oz" -> {"value": 64, "unit": "fl oz"}). Transcribe only — never convert units yourself. Null when no net content is legible.
4. If a nutrition facts panel is visible, TRANSCRIBE IT AS PRINTED — do NOT do any arithmetic:
   - ABSENT LINE = 0: when the panel is legible but a nutrient line is simply NOT PRINTED (US labels omit nutrients present in insignificant amounts — Supplement Facts panels routinely omit protein, fat, and sugars entirely), record 0 for that nutrient. Reserve null for values that are genuinely unreadable, cut off, or when no panel is visible at all. A product whose panel omits a line is COMPLETE at 0, not unknown.
   - DUAL-COLUMN PANELS: when a panel prints multiple serving-size columns (e.g. "2 tsp (11.6g)" and "1 tsp (5.8g)"), use the FIRST/primary column consistently for serving_size_g, servings_per_container, and nutrition_per_serving — never mix columns.
   - serving_size_g: the serving size in grams as printed on the panel (e.g. "per 55g serving" -> 55). If the serving is printed only in a volume/count unit with a gram equivalent in parentheses, use the gram number. Null if no gram serving size is readable.
   - servings_per_container: the printed "servings per container" number, if shown. Null otherwise.
   - nutrition_per_serving: the PER-SERVING values exactly as printed (calories, protein_g, fat_g, sat_fat_g, carbs_g, sugar_g, fiber_g, sodium_mg). Any single value you cannot read is null; a partial panel fills what it shows and leaves the rest null.
   - nutrition_per_100g: ONLY if the panel itself prints a per-100g (or per-100ml) column, transcribe it; otherwise null. Never compute it yourself.
5. Ingredients: transcribe whatever ingredient information is legible, even if rough — a full ingredients panel verbatim (a single comma-separated string), a partial/cut-off list, or front-of-pack ingredient callouts. Null ONLY when there is genuinely no ingredient information anywhere in the photos.
6. Suggest up to 3 short alias strings someone might use when logging (e.g. "feta", "feta cheese").
7. unit_model_hint — judge the PACKAGING (not servings): does opening this product mean breaking into one of several individually-sealed atomic units, each starting its own freshness clock (a can 3-pack, a yogurt 4-pack, individually-wrapped bars) -> "counted"; or opening a single container that is then drawn down (a tub, bag, bottle, box of dry goods) -> "fraction". Null when the photos don't show enough of the packaging to judge. Servings-per-container says NOTHING about this — judge only from physical packaging.
</instructions>

<response_format>
Return ONLY a JSON object inside <label> tags. No markdown, no text outside the tags.

<label>
{
  "name": "product display name or null",
  "shelf_life_class": "pantry|frozen|fridge_long|fridge_short|produce|very_perishable|unknown",
  "package_size": "as printed or null",
  "serving_size_g": 0,
  "servings_per_container": 0,
  "nutrition_per_serving": {"calories": 0, "protein_g": 0, "fat_g": 0, "sat_fat_g": 0, "carbs_g": 0, "sugar_g": 0, "fiber_g": 0, "sodium_mg": 0},
  "nutrition_per_100g": {"calories": 0, "protein_g": 0, "fat_g": 0, "sat_fat_g": 0, "carbs_g": 0, "sugar_g": 0, "fiber_g": 0, "sodium_mg": 0},
  "ingredients": "ingredients as printed (full, partial, or callouts), or null",
  "unit_model_hint": "counted|fraction|null",
  "net_content": {"value": 0, "unit": "g"},
  "aliases": ["short", "names"]
}
</label>

Any value you cannot read should be null (nutrition_per_serving / nutrition_per_100g themselves may be null when no panel is visible). Remember: nutrition_per_100g is ONLY for a printed per-100g column — never your own conversion.
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

    const nutrition = parsePanel(parsed.nutrition_per_100g);
    const perServing = parsePanel(parsed.nutrition_per_serving);
    const servingSizeG = numOrNull(parsed.serving_size_g);
    const servingsPerContainer = numOrNull(parsed.servings_per_container);
    const unitModelHint =
      parsed.unit_model_hint === 'counted' || parsed.unit_model_hint === 'fraction' ? parsed.unit_model_hint : null;

    let netContent: { value: number; unit: string } | null = null;
    if (parsed.net_content && typeof parsed.net_content === 'object') {
      const nc = parsed.net_content as Record<string, unknown>;
      if (
        typeof nc.value === 'number' &&
        Number.isFinite(nc.value) &&
        nc.value > 0 &&
        typeof nc.unit === 'string' &&
        nc.unit.trim()
      ) {
        netContent = { value: nc.value, unit: nc.unit.trim() };
      }
    }

    const ingredients =
      typeof parsed.ingredients === 'string' && parsed.ingredients.trim() ? parsed.ingredients.trim() : null;

    const aliases = Array.isArray(parsed.aliases)
      ? parsed.aliases.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim()).slice(0, 3)
      : [];

    return {
      name,
      shelf_life_class: cls,
      package_size: packageSize,
      serving_size_g: servingSizeG,
      servings_per_container: servingsPerContainer,
      nutrition_per_serving: perServing,
      nutrition_per_100g: nutrition,
      ingredients,
      unit_model_hint: unitModelHint,
      net_content: netContent,
      aliases,
    };
  }
}

/**
 * Deterministic net-content conversion (§ Prices' divisor — the model
 * transcribes {value, unit}; CODE converts): weight units → grams, volume
 * units → ml. Unknown/count units ("ct", "pk") → both null (counts are the
 * unit model's axis, not net content).
 */
export function convertNetContent(
  netContent: { value: number; unit: string } | null
): { net_content_g: number | null; net_content_ml: number | null } {
  if (!netContent || netContent.value <= 0) return { net_content_g: null, net_content_ml: null };
  const unit = netContent.unit.toLowerCase().replace(/[.\s]+/g, ' ').trim();
  const v = netContent.value;
  const round1 = (n: number) => Math.round(n * 10) / 10;

  const WEIGHT_PER_UNIT_G: Record<string, number> = {
    g: 1, gram: 1, grams: 1,
    kg: 1000,
    oz: 28.3495, ounce: 28.3495, ounces: 28.3495,
    lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592,
  };
  const VOLUME_PER_UNIT_ML: Record<string, number> = {
    ml: 1, milliliter: 1, milliliters: 1,
    l: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000,
    'fl oz': 29.5735, 'fluid oz': 29.5735, 'fluid ounce': 29.5735, 'fluid ounces': 29.5735, floz: 29.5735,
    qt: 946.353, quart: 946.353, quarts: 946.353,
    pt: 473.176, pint: 473.176, pints: 473.176,
    gal: 3785.41, gallon: 3785.41, gallons: 3785.41,
  };

  if (unit in WEIGHT_PER_UNIT_G) {
    return { net_content_g: round1(v * WEIGHT_PER_UNIT_G[unit]!), net_content_ml: null };
  }
  if (unit in VOLUME_PER_UNIT_ML) {
    return { net_content_g: null, net_content_ml: round1(v * VOLUME_PER_UNIT_ML[unit]!) };
  }
  return { net_content_g: null, net_content_ml: null };
}

function parsePanel(raw: unknown): Partial<NutritionPer100g> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    calories: numOrNull(r.calories),
    protein_g: numOrNull(r.protein_g),
    fat_g: numOrNull(r.fat_g),
    sat_fat_g: numOrNull(r.sat_fat_g),
    carbs_g: numOrNull(r.carbs_g),
    sugar_g: numOrNull(r.sugar_g),
    fiber_g: numOrNull(r.fiber_g),
    sodium_mg: numOrNull(r.sodium_mg),
  };
}

/**
 * Deterministic per-100g derivation (§ Nutrition panel — capture raw, scale
 * late): per_serving ÷ serving_size_g × 100, per field, in code — never model
 * arithmetic. Returns null when the raw serving data isn't usable (no
 * serving_size_g or no per-serving panel) — the caller then falls back to the
 * model's transcribed per-100g column, when one was printed.
 */
export function derivePer100gFromServing(
  servingSizeG: number | null,
  perServing: Partial<NutritionPer100g> | null
): Partial<NutritionPer100g> | null {
  if (!servingSizeG || servingSizeG <= 0 || !perServing) return null;
  const factor = 100 / servingSizeG;
  const scale = (v: number | null | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v * factor * 10) / 10 : null;
  return {
    calories: scale(perServing.calories),
    protein_g: scale(perServing.protein_g),
    fat_g: scale(perServing.fat_g),
    sat_fat_g: scale(perServing.sat_fat_g),
    carbs_g: scale(perServing.carbs_g),
    sugar_g: scale(perServing.sugar_g),
    fiber_g: scale(perServing.fiber_g),
    sodium_mg: scale(perServing.sodium_mg),
  };
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

type SupportedMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function normalizeMediaType(mimeType: string): SupportedMediaType {
  const allowed: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  return (allowed.includes(mimeType) ? mimeType : 'image/jpeg') as SupportedMediaType;
}
