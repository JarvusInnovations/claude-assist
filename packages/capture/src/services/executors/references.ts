/**
 * References executor: files link_reference captures into the
 * capture.references table (the open-tabs-graveyard replacement).
 *
 * The record shape mirrors the future `.gitsheets/references` sheet in the
 * Hari repo (see migrations/002-references.sql); the gitsheet export is a
 * documented follow-on once that repo restructure lands.
 */

import type { CaptureRecord, LinkMetadata } from '../../types.js';
import type { ReferenceStore } from '../../store.js';
import type { RoutingExecutor } from '../router.js';
import { collectUrls } from '../classifier.js';

/** The capture text with URLs removed = Chris's own note about the link */
export function extractNotes(text: string, urls: string[]): string {
  let notes = text;
  for (const url of urls) {
    notes = notes.split(url).join(' ');
  }
  return notes.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export class ReferencesExecutor implements RoutingExecutor {
  readonly destination = 'references';
  readonly kind = 'write' as const;

  constructor(private store: ReferenceStore) {}

  async execute(capture: CaptureRecord): Promise<Record<string, unknown>> {
    const urls = collectUrls(capture);
    if (urls.length === 0) {
      throw new Error('link_reference capture has no URL');
    }

    const links: LinkMetadata[] = capture.classification?.links ?? urls.map((url) => ({ url }));
    const primary = links.find((link) => link.url === urls[0]) ?? links[0] ?? { url: urls[0]! };
    const extras = links.filter((link) => link !== primary);

    await this.store.upsert({
      capture_ulid: capture.ulid,
      url: primary.url,
      final_url: primary.final_url ?? null,
      title: capture.classification?.title ?? primary.title ?? null,
      description: primary.description ?? null,
      site_name: primary.site_name ?? null,
      notes: extractNotes(capture.text, urls),
      tags: capture.tags,
      source: capture.source,
      captured_at: capture.captured_at,
      extra_urls: extras,
      fetch_error: primary.fetch_error ?? null,
    });

    return { reference: primary.url, extra_urls: extras.length };
  }
}
