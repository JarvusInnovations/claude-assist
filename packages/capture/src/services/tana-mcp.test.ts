import { describe, expect, it } from 'bun:test';
import { parseMcpBody } from './tana-mcp.js';

describe('parseMcpBody', () => {
  it('parses a plain JSON response (what tana-local actually sends)', () => {
    const body = '{"result":{"content":[{"type":"text","text":"ok"}]},"jsonrpc":"2.0","id":4}';
    const messages = parseMcpBody('application/json', body);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe(4);
  });

  it('parses SSE-framed responses per the streamable-HTTP spec', () => {
    const body = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      '',
      'data: {"jsonrpc":"2.0","id":2,"result":{"ok":false}}',
      '',
    ].join('\n');
    const messages = parseMcpBody('text/event-stream', body);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it('skips malformed SSE frames and empty bodies', () => {
    expect(parseMcpBody('text/event-stream', ': keepalive\n\ndata: not-json\n\n')).toEqual([]);
    expect(parseMcpBody('application/json', '')).toEqual([]);
  });

  it('handles JSON batch arrays', () => {
    const body = '[{"jsonrpc":"2.0","id":1,"result":{}},{"jsonrpc":"2.0","id":2,"result":{}}]';
    expect(parseMcpBody('application/json', body)).toHaveLength(2);
  });
});
