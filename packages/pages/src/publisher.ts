/**
 * Server-side implementation of core's `PagePublisher`.
 *
 * The HTTP publish route derives its base URL from the request's forwarded
 * headers. A scheduled pipeline has no request, so the only base URL available
 * is the configured one. When that is unset the publisher returns the
 * site-relative path rather than guessing a host: a link that is honestly
 * relative is fixable, a link to `https://localhost` in a notification is not.
 */

import type { PagePublisher, PublishPageInput, PublishedPage } from '@jarvus/claude-assist-core';
import type { PagesStore } from './store.js';
import {
  validateWorksheetDefinition,
  renderWorksheetHtml,
  WorksheetValidationError,
  type WorksheetDefinition,
} from './worksheet.js';

export function createPagePublisher(store: PagesStore, baseUrl?: string): PagePublisher {
  const root = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
  return {
    async publish(input: PublishPageInput): Promise<PublishedPage> {
      // Exactly one of html/worksheet, same rule the HTTP route enforces — the
      // in-process seam must not be a looser door into the same store.
      if ((input.html === undefined) === (input.worksheet === undefined)) {
        throw new WorksheetValidationError('exactly one of html or worksheet is required');
      }

      let definition: WorksheetDefinition | null = null;
      let html = input.html ?? '';
      if (input.worksheet !== undefined) {
        // Validated + rendered by ONE implementation (§ Computed totals: the
        // server's numbers are the stored ones), so a definition built in a
        // domain module gets the identical treatment as one posted over HTTP.
        definition = validateWorksheetDefinition(input.worksheet);
        html = renderWorksheetHtml(definition, input.title);
      }

      const result = await store.publish({
        slug: input.slug,
        title: input.title,
        html,
        ...(definition !== null ? { worksheet: definition } : {}),
        ...(input.digestOptin !== undefined ? { digestOptin: input.digestOptin } : {}),
      });
      return {
        slug: result.page.slug,
        url: `${root}/pages/${encodeURIComponent(result.page.slug)}`,
        created: result.created,
        versionId: result.version.id,
      };
    },
  };
}
