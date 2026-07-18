import { describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { PgCaptureStore, normalizeInput } from './store.js';
import { generateUlid } from './ulid.js';
import { buildObjectKey } from './services/attachments/storage.js';

/**
 * PgCaptureStore round-trip without a live DB: a stub `sql` tag captures the
 * bound values (verifying the INSERT carries the attachments column) and
 * returns a row with `attachments` as a JSON string — the shape postgres.js
 * hands back for a JSONB column — so rowToRecord's parse path is exercised too.
 */
describe('PgCaptureStore attachments round-trip', () => {
  it('writes attachments as JSONB and parses them back into an array', async () => {
    const ulid = generateUlid();
    const attachments = [
      {
        object_key: buildObjectKey(ulid, 0, 'photo.jpg'),
        filename: 'photo.jpg',
        content_type: 'image/jpeg',
        bytes: 1234,
      },
    ];
    const capture = normalizeInput({ ulid, source: 'app', text: 'has a photo', attachments });

    const bound: unknown[][] = [];
    const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
      bound.push(values);
      // Echo an inserted row back, JSONB fields as strings (postgres.js shape).
      return Promise.resolve([
        {
          ulid,
          source: 'app',
          text: 'has a photo',
          type_hint: null,
          urls: [],
          tags: [],
          payload: '{}',
          attachments: JSON.stringify(attachments),
          captured_at: capture.captured_at,
          received_at: new Date(),
          status: 'queued',
          classification: null,
          classified_at: null,
          classify_attempts: 0,
          route_destination: null,
          route_attempts: 0,
          routed_at: null,
          route_result: null,
          last_error: null,
          last_error_at: null,
          resolution: null,
          resolved_at: null,
        },
      ]);
    }) as unknown as postgres.Sql;

    const store = new PgCaptureStore(sql);
    const { record, created } = await store.insertIfAbsent(capture);

    expect(created).toBe(true);
    // The INSERT bound a stringified attachments value.
    const insertValues = bound[0]!;
    expect(insertValues).toContain(JSON.stringify(attachments));
    // rowToRecord parsed the JSONB string column into an array.
    expect(record.attachments).toEqual(attachments);
  });
});
