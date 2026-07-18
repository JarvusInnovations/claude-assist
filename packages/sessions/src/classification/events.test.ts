import { describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { parseClassificationEvents, buildClassificationPrompt } from './events.js';
import { ClassificationStore } from './store.js';
import type { DetectedEvent } from './types.js';

describe('parseClassificationEvents', () => {
  it('parses a valid <events> array with all fields', () => {
    const text = `<events>
[
  { "type": "correction", "summary": "the owner fixed the branch name", "confidence": 0.9, "quote": "no, it's develop" },
  { "type": "friction", "summary": "tofu apply failed 3x", "confidence": 0.7, "quote": "error again" }
]
</events>`;
    const events = parseClassificationEvents(text);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('correction');
    expect(events[0]!.quote).toBe("no, it's develop");
    expect(events[1]!.type).toBe('friction');
  });

  it('treats an empty array as valid (the common case)', () => {
    expect(parseClassificationEvents('<events>\n[]\n</events>')).toEqual([]);
  });

  it('drops unknown types and summary-less rows rather than failing the window', () => {
    const text = `<events>[
      { "type": "bogus", "summary": "x", "confidence": 1 },
      { "type": "rule-candidate", "summary": "", "confidence": 1 },
      { "type": "notable-decision", "summary": "picked postgres", "confidence": 0.8 }
    ]</events>`;
    const events = parseClassificationEvents(text);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('notable-decision');
    expect(events[0]!.quote).toBeNull();
  });

  it('clamps out-of-range confidence to a default', () => {
    const events = parseClassificationEvents(
      '<events>[{ "type": "correction", "summary": "s", "confidence": 5 }]</events>'
    );
    expect(events[0]!.confidence).toBe(0.5);
  });

  it('throws on a missing tag or malformed JSON', () => {
    expect(() => parseClassificationEvents('no tags here')).toThrow();
    expect(() => parseClassificationEvents('<events>{not json}</events>')).toThrow();
  });
});

describe('buildClassificationPrompt', () => {
  it('embeds session context and the delta window', () => {
    const prompt = buildClassificationPrompt({
      sessionId: 'sid',
      projectPath: '/repo/x',
      gitBranch: 'main',
      deltaText: '[U] do the thing\n[A] done',
    });
    expect(prompt).toContain('<project>/repo/x</project>');
    expect(prompt).toContain('<branch>main</branch>');
    expect(prompt).toContain('do the thing');
  });
});

// A recording `sql` double: captures the SQL text of every tagged-template
// query so we can prove events are only ever INSERTed (append-only), never
// UPDATEd or DELETEd.
function recordingSql(): { sql: postgres.Sql; queries: string[] } {
  const queries: string[] = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (Array.isArray(strings) && 'raw' in strings) {
      queries.push(strings.join(' ? '));
    }
    return Promise.resolve([]);
  }) as unknown as postgres.Sql & { queries: string[] };
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return { sql: fn, queries };
}

describe('ClassificationStore.appendEvents — append-only semantics', () => {
  const events: DetectedEvent[] = [
    { type: 'correction', summary: 'a', confidence: 0.9, quote: 'q1' },
    { type: 'friction', summary: 'b', confidence: 0.6, quote: null },
  ];

  it('issues one INSERT per event and never UPDATE/DELETE on classification_events', async () => {
    const { sql, queries } = recordingSql();
    const store = new ClassificationStore(sql);

    await store.appendEvents('sid', 4, 9, events, 'claude-haiku-4-5');

    const eventQueries = queries.filter((q) => q.includes('classification_events'));
    expect(eventQueries).toHaveLength(2); // one INSERT per event
    for (const q of eventQueries) {
      expect(q).toContain('INSERT INTO sessions.classification_events');
      expect(q).not.toMatch(/\bUPDATE\b/i);
      expect(q).not.toMatch(/\bDELETE\b/i);
    }
  });

  it('appending a second window does not touch the first (still only INSERTs)', async () => {
    const { sql, queries } = recordingSql();
    const store = new ClassificationStore(sql);

    await store.appendEvents('sid', 0, 3, [events[0]!], 'claude-haiku-4-5');
    await store.appendEvents('sid', 4, 9, [events[1]!], 'claude-haiku-4-5');

    const eventQueries = queries.filter((q) => q.includes('classification_events'));
    expect(eventQueries).toHaveLength(2);
    expect(eventQueries.every((q) => /INSERT INTO/i.test(q))).toBe(true);
  });
});
