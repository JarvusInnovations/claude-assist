import { describe, expect, it } from 'bun:test';
import { MemoryPagesStore } from './memory-store.js';

describe('PagesStore publish/republish versioning', () => {
  it('creates a page + its first version on first publish', async () => {
    const store = new MemoryPagesStore();
    const { page, version, created } = await store.publish({
      slug: 'tuning-session',
      title: 'Tuning session',
      html: '<html>v1</html>',
    });

    expect(created).toBe(true);
    expect(page.slug).toBe('tuning-session');
    expect(page.currentVersionId).toBe(version.id);
    expect(page.digestOptin).toBe(false);
    expect(page.archivedAt).toBeNull();

    const current = await store.getCurrent('tuning-session');
    expect(current?.html).toBe('<html>v1</html>');
  });

  it('republishing the same slug adds a new version and repoints current, retaining the prior version', async () => {
    const store = new MemoryPagesStore();
    const first = await store.publish({
      slug: 'tuning-session',
      title: 'Tuning session',
      html: '<html>v1</html>',
    });
    const second = await store.publish({
      slug: 'tuning-session',
      title: 'Tuning session v2',
      html: '<html>v2</html>',
    });

    expect(second.created).toBe(false);
    expect(second.version.id).not.toBe(first.version.id);
    expect(second.page.currentVersionId).toBe(second.version.id);
    expect(second.page.title).toBe('Tuning session v2');

    // Current serving reflects only the latest version...
    const current = await store.getCurrent('tuning-session');
    expect(current?.html).toBe('<html>v2</html>');

    // ...but the prior version's HTML is retained, not overwritten or deleted.
    expect(store.versions.get(first.version.id)?.html).toBe('<html>v1</html>');
    expect(store.versions.size).toBe(2);
  });

  it('republishing an archived slug reactivates it', async () => {
    const store = new MemoryPagesStore();
    await store.publish({ slug: 'stale', title: 'Stale', html: '<html>1</html>' });
    await store.archive('stale');
    expect((await store.getPage('stale'))?.archivedAt).not.toBeNull();

    await store.publish({ slug: 'stale', title: 'Stale', html: '<html>2</html>' });
    expect((await store.getPage('stale'))?.archivedAt).toBeNull();
  });

  it('preserves digest_optin across a republish unless explicitly overridden', async () => {
    const store = new MemoryPagesStore();
    await store.publish({
      slug: 'opted-in',
      title: 'Opted in',
      html: '<html>1</html>',
      digestOptin: true,
    });
    const { page } = await store.publish({
      slug: 'opted-in',
      title: 'Opted in',
      html: '<html>2</html>',
    });
    expect(page.digestOptin).toBe(true);

    const { page: overridden } = await store.publish({
      slug: 'opted-in',
      title: 'Opted in',
      html: '<html>3</html>',
      digestOptin: false,
    });
    expect(overridden.digestOptin).toBe(false);
  });

  it('getCurrent returns null for an unknown slug', async () => {
    const store = new MemoryPagesStore();
    expect(await store.getCurrent('does-not-exist')).toBeNull();
  });
});

describe('PagesStore responses: append-only + processed semantics', () => {
  it('appends responses and returns null for an unknown page', async () => {
    const store = new MemoryPagesStore();
    await store.publish({ slug: 'p', title: 'P', html: '<html/>' });

    const result = await store.addResponse('p', { payload: { choice: 'a' } });
    expect(result).not.toBeNull();
    expect(result?.response.processedAt).toBeNull();
    expect(result?.response.processedBy).toBeNull();

    expect(await store.addResponse('missing', { payload: {} })).toBeNull();
  });

  it('never overwrites payload/anchor/note — only processed_by/processed_at mutate', async () => {
    const store = new MemoryPagesStore();
    await store.publish({ slug: 'p', title: 'P', html: '<html/>' });
    const { response } = (await store.addResponse('p', {
      payload: { vote: 'yes' },
      anchor: '#section-2',
      note: 'looks good',
    }))!;

    const updated = await store.markProcessed('p', response.id, 'session-abc');
    expect(updated?.processedBy).toBe('session-abc');
    expect(updated?.processedAt).not.toBeNull();

    const [stored] = (await store.listResponses('p', {}))!;
    expect(stored!.payload).toEqual({ vote: 'yes' });
    expect(stored!.anchor).toBe('#section-2');
    expect(stored!.note).toBe('looks good');
  });

  it('markProcessed returns null for an unknown response id or slug', async () => {
    const store = new MemoryPagesStore();
    await store.publish({ slug: 'p', title: 'P', html: '<html/>' });
    const { response } = (await store.addResponse('p', { payload: {} }))!;

    expect(await store.markProcessed('p', response.id + 999, 'someone')).toBeNull();
    expect(await store.markProcessed('other-slug', response.id, 'someone')).toBeNull();
  });

  it('listResponses orders oldest-first and filters by unprocessedOnly', async () => {
    const store = new MemoryPagesStore();
    await store.publish({ slug: 'p', title: 'P', html: '<html/>' });
    const r1 = (await store.addResponse('p', { payload: { n: 1 } }))!.response;
    const r2 = (await store.addResponse('p', { payload: { n: 2 } }))!.response;

    await store.markProcessed('p', r1.id, 'someone');

    const all = (await store.listResponses('p', {}))!;
    expect(all.map((r) => r.id)).toEqual([r1.id, r2.id]);

    const unprocessed = (await store.listResponses('p', { unprocessedOnly: true }))!;
    expect(unprocessed.map((r) => r.id)).toEqual([r2.id]);
  });

  it('listResponses filters by since', async () => {
    const store = new MemoryPagesStore();
    await store.publish({ slug: 'p', title: 'P', html: '<html/>' });
    const r1 = (await store.addResponse('p', { payload: { n: 1 } }))!.response;
    // Force a deterministic gap: two responses inserted back-to-back can land
    // in the same millisecond, which would make a `since` cutoff derived from
    // r1's timestamp ambiguous for r2 too.
    const stored1 = store.responses.find((r) => r.id === r1.id)!;
    stored1.createdAt = new Date(2020, 0, 1);
    const cutoff = new Date(2020, 0, 2);
    const r2 = (await store.addResponse('p', { payload: { n: 2 } }))!.response;
    store.responses.find((r) => r.id === r2.id)!.createdAt = new Date(2020, 0, 3);

    const sinceCutoff = (await store.listResponses('p', { since: cutoff }))!;
    expect(sinceCutoff.map((r) => r.id)).toEqual([r2.id]);
  });

  it('listResponses returns null for an unknown slug', async () => {
    const store = new MemoryPagesStore();
    expect(await store.listResponses('missing', {})).toBeNull();
  });
});

describe('PagesStore archive', () => {
  it('is idempotent and keeps storage while removing from listActive', async () => {
    const store = new MemoryPagesStore();
    await store.publish({ slug: 'p', title: 'P', html: '<html/>' });
    const first = await store.archive('p');
    const firstArchivedAt = first?.archivedAt;
    const second = await store.archive('p');

    expect(second?.archivedAt).toEqual(firstArchivedAt ?? null);
    expect(await store.listActive()).toEqual([]);
    expect(await store.getCurrent('p')).not.toBeNull(); // storage retained
  });

  it('returns null for an unknown slug', async () => {
    const store = new MemoryPagesStore();
    expect(await store.archive('missing')).toBeNull();
  });
});
