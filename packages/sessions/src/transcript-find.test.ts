import { describe, expect, it } from 'bun:test';
import { findInTranscript, readAround } from './transcript.js';
import { parseTranscript } from './parser.js';

/** Build a JSONL transcript line. */
function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function userMsg(uuid: string, ts: string, text: string, extra: Record<string, unknown> = {}): string {
  return line({ type: 'user', uuid, parentUuid: null, timestamp: ts, message: { role: 'user', content: text }, ...extra });
}

function assistantMsg(
  uuid: string,
  ts: string,
  content: unknown[],
  extra: Record<string, unknown> = {}
): string {
  return line({ type: 'assistant', uuid, parentUuid: null, timestamp: ts, message: { role: 'assistant', content }, ...extra });
}

// A small, realistic session: deploy → Bash(tofu apply) → result → Edit(routes.ts) → thanks
const TRANSCRIPT = [
  userMsg('u0', '2026-06-23T10:00:00Z', "let's deploy the infra"),
  assistantMsg('u1', '2026-06-23T10:00:05Z', [
    { type: 'text', text: "I'll run terraform now" },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'tofu apply -concise' } },
  ]),
  userMsg('u2', '2026-06-23T10:00:20Z', 'looks good'),
  assistantMsg('u3', '2026-06-23T10:00:25Z', [{ type: 'text', text: 'Applied — 3 added' }]),
  assistantMsg('u4', '2026-06-23T10:01:00Z', [
    { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/repo/src/routes.ts' } },
  ]),
  userMsg('u5', '2026-06-23T10:02:00Z', 'thanks, ship it'),
].join('\n');

describe('parseTranscript tool_calls index', () => {
  it('extracts one row per tool_use with derived target + anchor uuid', () => {
    const parsed = parseTranscript('sid', TRANSCRIPT);
    expect(parsed.toolCalls).toHaveLength(2);
    const bash = parsed.toolCalls.find((t) => t.toolName === 'Bash')!;
    expect(bash.msgUuid).toBe('u1');
    expect(bash.target).toBe('tofu apply -concise');
    const edit = parsed.toolCalls.find((t) => t.toolName === 'Edit')!;
    expect(edit.msgUuid).toBe('u4');
    expect(edit.target).toBe('/repo/src/routes.ts');
    expect(edit.isSidechain).toBe(false);
  });
});

describe('findInTranscript', () => {
  it('matches by tool name and windows ±context with the anchor marked', () => {
    const matches = findInTranscript(TRANSCRIPT, { tool: 'Bash', context: 1 });
    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(m.anchor).toBe('u1');
    expect(m.tool).toBe('Bash');
    expect(m.target).toContain('tofu apply');
    // window is [u0, u1, u2]; the anchor line is prefixed '> ' and marked
    const marked = m.window.lines.find((l) => l.startsWith('> '));
    expect(marked).toBeDefined();
    expect(m.window.lines.join('\n')).toContain('<- match');
    expect(m.window.moreBefore).toBe(0);
    expect(m.window.moreAfter).toBe(3);
    expect(m.window.head).toBe('u0');
    expect(m.window.tail).toBe('u2');
  });

  it('matches a tool target substring', () => {
    const matches = findInTranscript(TRANSCRIPT, { match: 'tofu', in: 'target' });
    expect(matches.map((m) => m.anchor)).toEqual(['u1']);
  });

  it('matches message text', () => {
    const matches = findInTranscript(TRANSCRIPT, { match: 'ship it', in: 'text' });
    expect(matches.map((m) => m.anchor)).toEqual(['u5']);
  });

  it('matches a file target under the default "any" dimension', () => {
    const matches = findInTranscript(TRANSCRIPT, { match: 'routes.ts' });
    expect(matches.map((m) => m.anchor)).toEqual(['u4']);
  });

  it('respects after_uuid paging (resume past a match)', () => {
    const matches = findInTranscript(TRANSCRIPT, { match: 'routes.ts', afterUuid: 'u4' });
    expect(matches).toHaveLength(0);
  });

  it('honors limit', () => {
    const matches = findInTranscript(TRANSCRIPT, { match: 'o', in: 'text', limit: 1 });
    expect(matches).toHaveLength(1);
  });

  it('excludes sidechain messages by default', () => {
    const withSub =
      TRANSCRIPT +
      '\n' +
      assistantMsg('s1', '2026-06-23T10:03:00Z', [
        { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'echo sub' } },
      ], { isSidechain: true });
    expect(findInTranscript(withSub, { tool: 'Bash' }).map((m) => m.anchor)).toEqual(['u1']);
    expect(findInTranscript(withSub, { tool: 'Bash', includeSidechain: true }).map((m) => m.anchor)).toEqual(['u1', 's1']);
  });
});

describe('readAround', () => {
  it('returns an asymmetric window with edge anchors and remaining counts', () => {
    const w = readAround(TRANSCRIPT, 'u4', 1, 0)!;
    expect(w).not.toBeNull();
    expect(w.anchor).toBe('u4');
    expect(w.head).toBe('u3');
    expect(w.tail).toBe('u4');
    expect(w.moreBefore).toBe(3); // u0..u2 remain before u3
    expect(w.moreAfter).toBe(1); // u5 remains after u4
  });

  it('returns null for an unknown anchor', () => {
    expect(readAround(TRANSCRIPT, 'nope', 1, 1)).toBeNull();
  });
});
