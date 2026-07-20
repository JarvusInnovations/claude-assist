/**
 * Kitchen estimator: one structured-output vision call per estimation
 * attempt (photos + note → {label, calories, macros, confidence,
 * portion_basis}). Mirrors the capture classifier's XML-tagged-JSON +
 * one-retry pattern (services/classifier.ts) rather than the SDK's
 * `output_config.format` structured-outputs feature, so the estimation
 * model stays swappable to any vision-capable model the instance
 * configures (structured outputs has a narrower supported-model list).
 *
 * The capture action is the type hint (specs/modules/kitchen.md § Estimation
 * & model tiering) — there is no separate classification call here; the
 * caller already knows this is a meal-estimation job.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { FastifyBaseLogger } from 'fastify';
import type { ModelEstimate, PhotoPart } from '../types.js';

class EstimateParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EstimateParseError';
  }
}

export interface EstimatorConfig {
  apiKey: string;
  /** default: claude-fable-5 — the strongest vision tier for open-ended meal estimation. */
  model?: string;
  maxTokens?: number;
}

export interface EstimateInput {
  note: string | null;
  photos: PhotoPart[];
}

/** The pipeline depends on this narrow interface, not the concrete class — tests inject a fake. */
export interface Estimator {
  estimate(input: EstimateInput): Promise<ModelEstimate>;
}

export const SYSTEM_PROMPT = `<role>
You estimate the nutrition of a single home-logged meal or snack for a personal consumption journal. The owner wants a ballpark, not a lab result — a longitudinal record beats precision on any one entry.
</role>

<instructions>
1. Look at any photos and read the owner's note (if present). Identify what was eaten and a reasonable portion size.
2. Printed text in a photo — an order sticker, a packaging label, a menu board, or a nutrition panel in frame — is AUTHORITATIVE over your own visual read: trust it for identity, size, and ingredients ahead of guessing from appearance alone. Raise your confidence when the text corroborates what you see; a lazy shot with the label in frame is the most accurate case, not the least.
3. Estimate total calories and macros (protein_g, fat_g, sat_fat_g, carbs_g, sodium_mg) for the portion you can see/read — not a "standard serving" from a database, your own best visual/textual judgement (informed by any printed text per the rule above).
4. Give a short display label (under 60 chars) — e.g. "Grilled chicken salad", "Two slices pepperoni pizza".
5. State your portion basis in one short phrase (e.g. "one dinner plate, ~350g", "12oz based on the note").
6. State confidence 0.0-1.0. Lower confidence for ambiguous photos, no photos (note-only), or unusual foods.
7. If there is truly nothing to go on (no photo, no note, or unreadable), still return your best guess with low confidence — never refuse. A rough number beats no number.
</instructions>

<response_format>
Return ONLY a JSON object inside <estimate> tags. No markdown, no text outside the tags.

<estimate>
{
  "label": "short display label",
  "calories": 000,
  "macros": {"protein_g": 0, "fat_g": 0, "sat_fat_g": 0, "carbs_g": 0, "sodium_mg": 0},
  "confidence": 0.0,
  "portion_basis": "one short phrase"
}
</estimate>

Any macro you truly cannot estimate should be null, not 0 — 0 means "none", not "unknown".
</response_format>`;

export class KitchenEstimator implements Estimator {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private log: FastifyBaseLogger;

  constructor(config: EstimatorConfig, log: FastifyBaseLogger) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model ?? 'claude-fable-5';
    this.maxTokens = config.maxTokens ?? 1024;
    this.log = log;
  }

  async estimate(input: EstimateInput): Promise<ModelEstimate> {
    const content: Anthropic.ContentBlockParam[] = input.photos.map((photo) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: normalizeMediaType(photo.mimeType),
        data: photo.data.toString('base64'),
      },
    }));
    content.push({ type: 'text', text: buildPrompt(input.note, input.photos.length) });

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
        if (response.stop_reason === 'refusal') {
          throw new Error('Estimation refused by the model');
        }
        throw new Error('No text response from estimator');
      }
      messages.push({ role: 'assistant', content: textContent.text });

      try {
        return this.parseEstimate(textContent.text);
      } catch (error) {
        if (attempt < maxRetries && error instanceof EstimateParseError) {
          this.log.warn({ attempt, error: error.message }, 'Estimate parse failed, requesting correction');
          messages.push({
            role: 'user',
            content: `<error>Parse failed: ${error.message}</error>\n\nReturn the corrected JSON inside <estimate> tags.`,
          });
        } else {
          throw error;
        }
      }
    }

    throw new Error('Unexpected: estimator retry loop exited without result');
  }

  private parseEstimate(text: string): ModelEstimate {
    const match = text.match(/<estimate>\s*([\s\S]*?)\s*<\/estimate>/);
    if (!match) throw new EstimateParseError('No <estimate> tags found in response');

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(match[1]!.trim());
    } catch (error) {
      throw new EstimateParseError(
        `JSON parse error: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const label = typeof parsed.label === 'string' && parsed.label.trim() ? parsed.label.trim() : 'Logged item';
    const macros = (parsed.macros && typeof parsed.macros === 'object' ? parsed.macros : {}) as Record<
      string,
      unknown
    >;
    const confidence =
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : 0.3;
    const portionBasis =
      typeof parsed.portion_basis === 'string' && parsed.portion_basis.trim() ? parsed.portion_basis.trim() : '';

    return {
      label,
      calories: numOrNull(parsed.calories),
      protein_g: numOrNull(macros.protein_g),
      fat_g: numOrNull(macros.fat_g),
      sat_fat_g: numOrNull(macros.sat_fat_g),
      carbs_g: numOrNull(macros.carbs_g),
      sodium_mg: numOrNull(macros.sodium_mg),
      confidence,
      portion_basis: portionBasis,
    };
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

function buildPrompt(note: string | null, photoCount: number): string {
  return `<entry>
<photo_count>${photoCount}</photo_count>
${note ? `<note>\n${note}\n</note>` : '<note>(none)</note>'}
</entry>`;
}

/**
 * Server-side portion modifier: explicit multiplier words in the note
 * (e.g. "double", "half") scale the model's base estimate. The model
 * already reads the note for descriptive portion size ("a large bowl of…"),
 * so this only fires on standalone multiplier tokens to avoid double-counting.
 */
const PORTION_MODIFIERS: Array<{ pattern: RegExp; factor: number }> = [
  { pattern: /\bdouble\b|\b2x\b|\bx2\b/i, factor: 2 },
  { pattern: /\btriple\b|\b3x\b|\bx3\b/i, factor: 3 },
  { pattern: /\bhalf\b|\b1\/2\b/i, factor: 0.5 },
  { pattern: /\bquarter\b|\b1\/4\b/i, factor: 0.25 },
];

export function portionModifierFor(note: string | null): number {
  if (!note) return 1;
  for (const { pattern, factor } of PORTION_MODIFIERS) {
    if (pattern.test(note)) return factor;
  }
  return 1;
}

export function applyPortionModifier(estimate: ModelEstimate, factor: number): ModelEstimate {
  if (factor === 1) return estimate;
  const scale = (n: number | null) => (n === null ? null : Math.round(n * factor * 10) / 10);
  return {
    ...estimate,
    calories: scale(estimate.calories),
    protein_g: scale(estimate.protein_g),
    fat_g: scale(estimate.fat_g),
    sat_fat_g: scale(estimate.sat_fat_g),
    carbs_g: scale(estimate.carbs_g),
    sodium_mg: scale(estimate.sodium_mg),
  };
}
