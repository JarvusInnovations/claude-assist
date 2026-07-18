import { describe, expect, it } from 'bun:test';
import {
  buildObjectKey,
  objectKeyPrefix,
  sanitizeFilename,
} from './storage.js';
import { MemoryAttachmentStorage } from './storage-memory.js';

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('object key helpers', () => {
  it('builds a ULID-keyed object key', () => {
    expect(buildObjectKey(ULID, 0, 'photo.jpg')).toBe(`captures/${ULID}/0-photo.jpg`);
    expect(buildObjectKey(ULID, 2, 'notes.pdf')).toBe(`captures/${ULID}/2-notes.pdf`);
  });

  it('sanitizes filenames to a safe basename (no traversal, no separators)', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('a b/c.png')).toBe('c.png');
    expect(sanitizeFilename('weird name!@#.PNG')).toBe('weird_name_.PNG');
    expect(sanitizeFilename('...')).toBe('file');
  });

  it('key prefix matches the keys it builds', () => {
    const key = buildObjectKey(ULID, 0, 'x.png');
    expect(key.startsWith(objectKeyPrefix(ULID))).toBe(true);
  });
});

describe('MemoryAttachmentStorage', () => {
  it('signUpload records intent but does not create the object', async () => {
    const storage = new MemoryAttachmentStorage();
    const key = buildObjectKey(ULID, 0, 'photo.jpg');
    const url = await storage.signUpload({ object_key: key, content_type: 'image/jpeg', bytes: 10 });
    expect(url).toContain(key);
    expect(url).toContain('contentType=image');
    expect(url).toContain('contentLength=10');
    // Not uploaded yet
    expect(await storage.objectExists(key)).toBe(false);
  });

  it('objectExists reflects only put() objects; signRead returns a url', async () => {
    const storage = new MemoryAttachmentStorage();
    const key = buildObjectKey(ULID, 0, 'photo.jpg');
    storage.put(key, { content_type: 'image/jpeg', bytes: 10 });
    expect(await storage.objectExists(key)).toBe(true);
    expect(await storage.signRead(key)).toBe(`memory://read/${key}`);
  });
});
