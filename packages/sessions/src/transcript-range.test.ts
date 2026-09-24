import { describe, expect, it } from 'bun:test';
import { serializeMessageRange } from './transcript.js';

/** Build a JSONL transcript line. */
function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}
function userMsg(uuid: string, ts: string, text: string): string {
  return line({ type: 'user', uuid, parentUuid: null, timestamp: ts, message: { role: 'user', content: text } });
}
function assistantMsg(uuid: string, ts: string, text: string): string {
  return line({ type: 'assistant', uuid, parentUuid: null, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

const TRANSCRIPT = [
  userMsg('u0', '2026-07-01T10:00:00Z', 'first task'),
  assistantMsg('u1', '2026-07-01T10:00:05Z', 'working on it'),
  userMsg('u2', '2026-07-01T10:01:00Z', 'second task'),
  assistantMsg('u3', '2026-07-01T10:01:05Z', 'done'),
].join('\n');

describe('serializeMessageRange — bounded message range primitive', () => {
  it('serializes a bounded [fromSeq, toSeq] range', () => {
    const r = serializeMessageRange(TRANSCRIPT, 1, 2);
    expect(r.seqStart).toBe(1);
    expect(r.seqEnd).toBe(2);
    expect(r.count).toBe(2);
    expect(r.text).toContain('working on it');
    expect(r.text).toContain('second task');
    expect(r.text).not.toContain('first task');
    expect(r.text).not.toContain('done');
  });

  it('reads to the end when toSeq is omitted', () => {
    const r = serializeMessageRange(TRANSCRIPT, 2);
    expect(r.seqStart).toBe(2);
    expect(r.seqEnd).toBe(3);
    expect(r.count).toBe(2);
    expect(r.text).toContain('second task');
    expect(r.text).toContain('done');
  });

  it('reads the whole transcript from fromSeq=0 with no toSeq', () => {
    const r = serializeMessageRange(TRANSCRIPT, 0);
    expect(r.seqStart).toBe(0);
    expect(r.seqEnd).toBe(3);
    expect(r.count).toBe(4);
  });

  it('clamps toSeq past the end of the transcript', () => {
    const r = serializeMessageRange(TRANSCRIPT, 2, 999);
    expect(r.seqEnd).toBe(3);
    expect(r.count).toBe(2);
  });

  it('clamps a negative fromSeq to 0', () => {
    const r = serializeMessageRange(TRANSCRIPT, -5, 0);
    expect(r.seqStart).toBe(0);
    expect(r.seqEnd).toBe(0);
    expect(r.count).toBe(1);
  });

  it('returns an empty result when fromSeq is beyond the transcript', () => {
    const r = serializeMessageRange(TRANSCRIPT, 10);
    expect(r).toEqual({ text: '', seqStart: -1, seqEnd: -1, count: 0 });
  });

  it('returns an empty result for an empty transcript', () => {
    const r = serializeMessageRange('', 0);
    expect(r).toEqual({ text: '', seqStart: -1, seqEnd: -1, count: 0 });
  });

  it('returns an empty result when fromSeq > toSeq', () => {
    const r = serializeMessageRange(TRANSCRIPT, 2, 1);
    expect(r).toEqual({ text: '', seqStart: -1, seqEnd: -1, count: 0 });
  });
});
