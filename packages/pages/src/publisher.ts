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

export function createPagePublisher(store: PagesStore, baseUrl?: string): PagePublisher {
  const root = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
  return {
    async publish(input: PublishPageInput): Promise<PublishedPage> {
      const result = await store.publish({
        slug: input.slug,
        title: input.title,
        html: input.html,
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
