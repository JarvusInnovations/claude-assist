import { describe, expect, it } from 'bun:test';
import { KitchenEventExecutor } from './kitchen-event.js';
import { ROUTING_TABLE } from '../../state.js';
import { CAPTURE_TYPES } from '../../types.js';
import type { CaptureRecord } from '../../types.js';

function mkCapture(text: string): CaptureRecord {
  const now = new Date();
  return {
    ulid: '01J0000000000000000000KEV0',
    source: 'app',
    text,
    type_hint: null,
    urls: [],
    tags: [],
    payload: {},
    attachments: [],
    captured_at: now,
    received_at: now,
    status: 'classified',
    classification: null,
    classified_at: null,
    classify_attempts: 0,
    route_destination: 'kitchen-event',
    route_attempts: 0,
    routed_at: null,
    route_result: null,
    last_error: null,
    last_error_at: null,
    resolution: null,
    resolved_at: null,
  };
}

describe('kitchen_event routing', () => {
  it('kitchen_event is a known type routing to the kitchen-event destination', () => {
    expect(CAPTURE_TYPES).toContain('kitchen_event');
    expect(ROUTING_TABLE.kitchen_event).toBe('kitchen-event');
  });
});

describe('KitchenEventExecutor', () => {
  it('hands the remark text to the injected resolver and returns its outcome', async () => {
    const seen: string[] = [];
    const executor = new KitchenEventExecutor(async (remark) => {
      seen.push(remark);
      return { matched: true, itemUlid: 'ITEM1', eventType: 'opened' };
    });
    expect(executor.destination).toBe('kitchen-event');
    expect(executor.kind).toBe('write');

    const result = await executor.execute(mkCapture('opened the feta'));
    expect(seen).toEqual(['opened the feta']);
    expect(result).toEqual({ matched: true, item_ulid: 'ITEM1', event_type: 'opened' });
  });

  it('an unmatched remark is a normal (non-throwing) outcome → the capture routes', async () => {
    const executor = new KitchenEventExecutor(async () => ({ matched: false }));
    const result = await executor.execute(mkCapture('opened the caviar'));
    expect(result).toEqual({ matched: false, item_ulid: null, event_type: null });
  });
});
