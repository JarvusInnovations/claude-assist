/**
 * Capture classifier.
 *
 * Cheap-model (Haiku) pass over each queued capture, mirroring the email
 * triage patterns: XML-tagged JSON output, one parse-correction retry,
 * validation of the returned enum. A deterministic pre-pass short-circuits
 * the common link-dropbox case (URL-only capture) with zero model spend.
 *
 * The prompt is deliberately rough — routing corrections are cheap and will
 * tune it. The taxonomy lives in CAPTURE_TYPES (types.ts); future types
 * (diet) extend that list + this prompt + ROUTING_TABLE.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { FastifyBaseLogger } from 'fastify';
import type {
  CaptureRecord,
  CaptureType,
  Classification,
  LinkMetadata,
} from '../types.js';
import { CAPTURE_TYPES } from '../types.js';
import { extractUrls, isUrlOnly } from './link-metadata.js';

class ClassificationParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassificationParseError';
  }
}

/** All URLs for a capture: explicit urls[] plus any found in the text */
export function collectUrls(capture: Pick<CaptureRecord, 'text' | 'urls'>): string[] {
  return [...new Set([...capture.urls, ...extractUrls(capture.text)])];
}

/**
 * Deterministic pre-pass: a capture whose content is nothing but URL(s) is
 * a link_reference — no model call needed.
 */
export function deterministicClassification(
  capture: Pick<CaptureRecord, 'text' | 'urls'>
): Classification | null {
  const urls = collectUrls(capture);
  if (urls.length > 0 && isUrlOnly(capture.text, urls)) {
    return {
      type: 'link_reference',
      confidence: 1,
      title: null,
      rationale: 'URL-only capture (deterministic link-dropbox shortcut)',
      classifier: 'deterministic',
    };
  }
  return null;
}

export interface ClassifierConfig {
  apiKey: string;
  /** default: claude-haiku-4-5 */
  model?: string;
  maxTokens?: number;
}

const SYSTEM_PROMPT = `<role>
You classify short personal captures — stray thoughts, links, and notes that the owner (a consulting-business owner) jotted down for himself. Your only job is to pick the capture's type so a router can file it. You never act on the content.
</role>

<taxonomy>
- stray_thought: An idea, observation, reminder-to-self, or note with no clear next action and no team relevance. The default when nothing else clearly fits.
- link_reference: The capture exists to save a URL/article/tool for later reference. Commentary about a link is still link_reference when the link is the point.
- actionable: The capture describes something the owner needs to DO — a task, follow-up, errand, or promise ("email the accountant about the invoice", "renew the domain"). A vague topic to maybe explore someday is a stray_thought, not actionable.
- team_relevant: The capture is primarily about Jarvus team/client/project matters that would belong in the team's shared record — client situations, project decisions, personnel notes, leads. When a capture is both actionable and team-relevant, prefer team_relevant.
- kitchen_event: The capture is a passing remark about the owner's food/kitchen inventory — that an item was opened, finished/used up, or thrown out/tossed (e.g. "opened the feta", "finished the milk", "tossed half the tomatoes"). Only physical stock-state changes count, not meals eaten or shopping plans.
</taxonomy>

<instructions>
1. Read the capture text, any URLs (with fetched page metadata), tags, and the optional client hint.
2. The hint is advisory: trust the content over the hint when they disagree.
3. Pick exactly one type from the taxonomy.
4. Suggest a short title (under 80 chars) usable in a review list.
5. State confidence 0.0-1.0 and a one-sentence rationale.
</instructions>

<response_format>
Return ONLY a JSON object inside <classification> tags. No markdown, no text outside the tags.

<classification>
{
  "type": "stray_thought|link_reference|actionable|team_relevant|kitchen_event",
  "confidence": 0.0,
  "title": "short display title",
  "rationale": "one sentence"
}
</classification>
</response_format>`;

export class CaptureClassifier {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private log: FastifyBaseLogger;

  constructor(config: ClassifierConfig, log: FastifyBaseLogger) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model ?? 'claude-haiku-4-5';
    this.maxTokens = config.maxTokens ?? 1024;
    this.log = log;
  }

  /**
   * Classify a capture. `links` is pre-fetched URL metadata (attached to
   * the returned classification either way).
   */
  async classify(capture: CaptureRecord, links: LinkMetadata[]): Promise<Classification> {
    const deterministic = deterministicClassification(capture);
    if (deterministic) {
      return links.length > 0 ? { ...deterministic, links } : deterministic;
    }

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: this.buildPrompt(capture, links) },
    ];

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
        throw new Error('No text response from classifier');
      }
      messages.push({ role: 'assistant', content: textContent.text });

      try {
        const parsed = this.parseClassification(textContent.text);
        return {
          ...parsed,
          classifier: 'model',
          model: this.model,
          ...(links.length > 0 ? { links } : {}),
        };
      } catch (error) {
        if (attempt < maxRetries && error instanceof ClassificationParseError) {
          this.log.warn(
            { ulid: capture.ulid, attempt, error: error.message },
            'Classification parse failed, requesting correction'
          );
          messages.push({
            role: 'user',
            content: `<error>Parse failed: ${error.message}</error>\n\nReturn the corrected JSON inside <classification> tags.`,
          });
        } else {
          throw error;
        }
      }
    }

    throw new Error('Unexpected: classifier retry loop exited without result');
  }

  private buildPrompt(capture: CaptureRecord, links: LinkMetadata[]): string {
    const linksBlock = links
      .map((link) => {
        const parts = [
          `<url>${link.url}</url>`,
          link.title ? `<title>${link.title}</title>` : null,
          link.description ? `<description>${link.description}</description>` : null,
          link.site_name ? `<site>${link.site_name}</site>` : null,
          link.fetch_error ? `<fetch_error>${link.fetch_error}</fetch_error>` : null,
        ].filter(Boolean);
        return `<link>${parts.join('')}</link>`;
      })
      .join('\n');

    return `<capture>
<source>${capture.source}</source>
<captured_at>${capture.captured_at.toISOString()}</captured_at>
${capture.type_hint ? `<client_hint>${capture.type_hint}</client_hint>\n` : ''}${
      capture.tags.length > 0 ? `<tags>${capture.tags.join(', ')}</tags>\n` : ''
    }<text>
${capture.text}
</text>
${linksBlock ? `<links>\n${linksBlock}\n</links>` : ''}
</capture>`;
  }

  private parseClassification(
    text: string
  ): Pick<Classification, 'type' | 'confidence' | 'title' | 'rationale'> {
    const match = text.match(/<classification>\s*([\s\S]*?)\s*<\/classification>/);
    if (!match) {
      throw new ClassificationParseError('No <classification> tags found in response');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(match[1]!.trim());
    } catch (error) {
      throw new ClassificationParseError(
        `JSON parse error: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const type = parsed.type;
    if (!CAPTURE_TYPES.includes(type as CaptureType)) {
      throw new ClassificationParseError(
        `Invalid type: ${String(type)}. Must be one of: ${CAPTURE_TYPES.join(', ')}`
      );
    }

    const confidence =
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : 0.5;

    return {
      type: type as CaptureType,
      confidence,
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    };
  }
}
