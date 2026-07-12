/**
 * In-memory PagesStore implementation. Mirrors PgPagesStore semantics
 * exactly (versioning + append-only responses) so routes are testable
 * without Postgres.
 */

import type {
  ListResponsesFilter,
  NewResponseInput,
  PageRecord,
  PageResponseRecord,
  PageVersionRecord,
  PublishInput,
  PublishResult,
} from './types.js';
import type { PagesStore } from './store.js';

export class MemoryPagesStore implements PagesStore {
  private nextPageId = 1;
  private nextVersionId = 1;
  private nextResponseId = 1;

  readonly pages = new Map<string, PageRecord>(); // keyed by slug
  readonly versions = new Map<number, PageVersionRecord>(); // keyed by version id
  readonly responses: PageResponseRecord[] = [];

  async publish(input: PublishInput): Promise<PublishResult> {
    const now = new Date();
    const existing = this.pages.get(input.slug);

    if (!existing) {
      const page: PageRecord = {
        id: this.nextPageId++,
        slug: input.slug,
        title: input.title,
        currentVersionId: null,
        digestOptin: input.digestOptin ?? false,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      const version: PageVersionRecord = {
        id: this.nextVersionId++,
        pageId: page.id,
        html: input.html,
        createdAt: now,
      };
      page.currentVersionId = version.id;
      this.versions.set(version.id, version);
      this.pages.set(page.slug, page);
      return { page: { ...page }, version: { ...version }, created: true };
    }

    const version: PageVersionRecord = {
      id: this.nextVersionId++,
      pageId: existing.id,
      html: input.html,
      createdAt: now,
    };
    this.versions.set(version.id, version);

    const updated: PageRecord = {
      ...existing,
      title: input.title,
      currentVersionId: version.id,
      digestOptin: input.digestOptin ?? existing.digestOptin,
      archivedAt: null,
      updatedAt: now,
    };
    this.pages.set(updated.slug, updated);
    return { page: { ...updated }, version: { ...version }, created: false };
  }

  async getPage(slug: string): Promise<PageRecord | null> {
    const page = this.pages.get(slug);
    return page ? { ...page } : null;
  }

  async getCurrent(slug: string): Promise<{ page: PageRecord; html: string } | null> {
    const page = this.pages.get(slug);
    if (!page || page.currentVersionId === null) return null;
    const version = this.versions.get(page.currentVersionId);
    if (!version) return null;
    return { page: { ...page }, html: version.html };
  }

  async listActive(): Promise<PageRecord[]> {
    return [...this.pages.values()]
      .filter((p) => p.archivedAt === null)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((p) => ({ ...p }));
  }

  async archive(slug: string): Promise<PageRecord | null> {
    const page = this.pages.get(slug);
    if (!page) return null;
    if (page.archivedAt === null) {
      page.archivedAt = new Date();
    }
    return { ...page };
  }

  async addResponse(
    slug: string,
    input: NewResponseInput
  ): Promise<{ page: PageRecord; response: PageResponseRecord } | null> {
    const page = this.pages.get(slug);
    if (!page) return null;

    const response: PageResponseRecord = {
      id: this.nextResponseId++,
      pageId: page.id,
      payload: input.payload,
      anchor: input.anchor ?? null,
      note: input.note ?? null,
      createdAt: new Date(),
      processedBy: null,
      processedAt: null,
    };
    this.responses.push(response);
    return { page: { ...page }, response: { ...response } };
  }

  async listResponses(
    slug: string,
    filter: ListResponsesFilter
  ): Promise<PageResponseRecord[] | null> {
    const page = this.pages.get(slug);
    if (!page) return null;

    return this.responses
      .filter((r) => r.pageId === page.id)
      .filter((r) => !filter.since || r.createdAt.getTime() > filter.since.getTime())
      .filter((r) => !filter.unprocessedOnly || r.processedAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => ({ ...r }));
  }

  async markProcessed(
    slug: string,
    responseId: number,
    processedBy: string
  ): Promise<PageResponseRecord | null> {
    const page = this.pages.get(slug);
    if (!page) return null;

    const response = this.responses.find((r) => r.id === responseId && r.pageId === page.id);
    if (!response) return null;

    response.processedBy = processedBy;
    response.processedAt = new Date();
    return { ...response };
  }
}
