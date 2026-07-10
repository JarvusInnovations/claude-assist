import { describe, expect, it } from 'bun:test';
import { buildCandidates, type Conversation, type RawSlackMessage } from './poller.js';

const OWNER = 'U_OWNER';
const dm: Conversation = { id: 'D1', type: 'im' };
const channel: Conversation = { id: 'C1', type: 'channel' };

describe('buildCandidates', () => {
  it('skips Chris\'s own messages and bots as candidates', () => {
    const msgs: RawSlackMessage[] = [
      { ts: '1', user: OWNER, text: 'my own note' },
      { ts: '2', bot_id: 'B1', text: 'bot alert' },
      { ts: '3', user: 'U_TEAM', text: 'a real question?' },
    ];
    const { items, newestTs } = buildCandidates(msgs, dm, OWNER, 4);
    expect(items).toHaveLength(1);
    expect(items[0]!.candidate.sender).toBe('U_TEAM');
    expect(newestTs).toBe('3');
  });

  it('marks ownerRepliedAfter when Chris replied later in the same thread', () => {
    const msgs: RawSlackMessage[] = [
      { ts: '10', user: 'U_TEAM', text: 'can you look?', thread_ts: '10' },
      { ts: '11', user: OWNER, text: 'on it', thread_ts: '10' },
    ];
    const { items } = buildCandidates(msgs, dm, OWNER, 4);
    expect(items).toHaveLength(1);
    expect(items[0]!.ctx.ownerRepliedAfter).toBe(true);
  });

  it('does not mark ownerRepliedAfter across different threads', () => {
    const msgs: RawSlackMessage[] = [
      { ts: '10', user: 'U_TEAM', text: 'can you look?', thread_ts: '10' },
      { ts: '11', user: OWNER, text: 'unrelated reply', thread_ts: '99' },
    ];
    const { items } = buildCandidates(msgs, dm, OWNER, 4);
    expect(items[0]!.ctx.ownerRepliedAfter).toBe(false);
  });

  it('detects an @mention of the owner in a channel', () => {
    const msgs: RawSlackMessage[] = [{ ts: '5', user: 'U_TEAM', text: `hey <@${OWNER}> ping` }];
    const { items } = buildCandidates(msgs, channel, OWNER, 4);
    expect(items[0]!.ctx.mentionsOwner).toBe(true);
    expect(items[0]!.ctx.isDirectMessage).toBe(false);
  });

  it('builds preceding thread context (owner rendered as "Chris")', () => {
    const msgs: RawSlackMessage[] = [
      { ts: '1', user: OWNER, text: 'earlier note', thread_ts: '1' },
      { ts: '2', user: 'U_TEAM', text: 'and now the ask?', thread_ts: '1' },
    ];
    const { items } = buildCandidates(msgs, dm, OWNER, 4);
    expect(items[0]!.ctx.threadContext).toEqual([{ who: 'Chris', text: 'earlier note' }]);
  });
});
