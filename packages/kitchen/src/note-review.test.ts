import { describe, it, expect } from 'bun:test';
import { normalizeNewEntry } from './store.js';
import { MemoryEntryStore } from './memory-store.js';
import { generateUlid } from './ulid.js';

/**
 * specs/modules/kitchen.md § Unreviewed entry notes.
 *
 * The load-bearing distinction under test: a note EXISTING is not the same as a
 * human having said something. Cook mode always appends a measured-provenance
 * manifest, so note-presence would flag every submitted sheet — which is exactly
 * the "queue nobody can drain" failure the design rejects.
 */
describe('normalizeNewEntry — note provenance', () => {
  it('leaves an entry reviewed when there is no note at all', () => {
    const e = normalizeNewEntry({ ulid: generateUlid() });
    expect(e.note).toBeNull();
    expect(e.notes_reviewed).toBe(true);
  });

  it('leaves an agent-composed note reviewed (human_note omitted)', () => {
    const e = normalizeNewEntry({ ulid: generateUlid(), note: 'worksheet: 186g yogurt, 51g egg' });
    expect(e.note).toContain('worksheet:');
    expect(e.notes_reviewed).toBe(true);
  });

  it('flags a human note unreviewed', () => {
    const e = normalizeNewEntry({ ulid: generateUlid(), note: 'put tabasco on it', human_note: true });
    expect(e.notes_reviewed).toBe(false);
  });

  it('does NOT flag human_note with an empty note — nothing to review', () => {
    const e = normalizeNewEntry({ ulid: generateUlid(), note: '   ', human_note: true });
    expect(e.note).toBeNull();
    expect(e.notes_reviewed).toBe(true);
  });
});

describe('the unreviewed-note queue', () => {
  const seed = async (store: MemoryEntryStore, note: string | undefined, human: boolean, at: string) => {
    const entry = normalizeNewEntry({ ulid: generateUlid(), note, human_note: human, logged_at: at });
    await store.insertIfAbsent(entry);
    return entry.ulid;
  };

  it('lists only human-noted entries, oldest first', async () => {
    const store = new MemoryEntryStore();
    await seed(store, 'worksheet: 100g rice', false, '2026-08-01T12:00:00Z');
    const second = await seed(store, 'extra oil', true, '2026-08-03T12:00:00Z');
    const first = await seed(store, 'a splash of hot sauce', true, '2026-08-02T12:00:00Z');
    await seed(store, undefined, false, '2026-08-04T12:00:00Z');

    const queue = await store.listUnreviewedNotes();
    expect(queue.map((e) => e.ulid)).toEqual([first, second]);
    expect(await store.countUnreviewedNotes()).toBe(2);
  });

  it('review clears the flag and is idempotent', async () => {
    const store = new MemoryEntryStore();
    const ulid = await seed(store, 'extra oil', true, '2026-08-02T12:00:00Z');

    expect(await store.markNotesReviewed(ulid)).toBe(true);
    expect(await store.countUnreviewedNotes()).toBe(0);
    // A replay must read as a no-op, never a failure.
    expect(await store.markNotesReviewed(ulid)).toBe(false);
    expect(await store.countUnreviewedNotes()).toBe(0);
  });

  it('review leaves the note itself intact — it records reading, not correcting', async () => {
    const store = new MemoryEntryStore();
    const ulid = await seed(store, 'a splash of hot sauce', true, '2026-08-02T12:00:00Z');
    await store.markNotesReviewed(ulid);

    const entry = await store.get(ulid);
    expect(entry?.note).toBe('a splash of hot sauce');
    expect(entry?.notes_reviewed).toBe(true);
    // Panel untouched: reviewing is not a correction.
    expect(entry?.calories).toBeNull();
    expect(entry?.sodium_mg).toBeNull();
  });
});

describe('patching a note re-opens the question', () => {
  it('a note patch re-flags; a macro-only patch does not', async () => {
    const store = new MemoryEntryStore();
    const ulid = generateUlid();
    await store.insertIfAbsent(normalizeNewEntry({ ulid, note: 'worksheet: 100g rice' }));
    await store.markNotesReviewed(ulid);
    expect(await store.countUnreviewedNotes()).toBe(0);

    // Macro-only override: the owner corrected numbers, said nothing.
    await store.applyManualOverride(ulid, { calories: 300 }, {});
    expect(await store.countUnreviewedNotes()).toBe(0);

    // Now the owner actually says something.
    await store.applyManualOverride(ulid, {}, { note: 'also had a splash of oil' });
    expect(await store.countUnreviewedNotes()).toBe(1);
  });
});
