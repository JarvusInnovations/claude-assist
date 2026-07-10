/**
 * Slack Web API reader over a USER token (xoxp-…), reading AS Chris.
 *
 * This is the production `SlackReader`. It wraps only read endpoints:
 *   conversations.list · conversations.history · users.info · chat.getPermalink
 * The same user token the `slack-axi` CLI stores works here; supply it as
 * SLACK_URGENCY_USER_TOKEN. A user display name cache keeps users.info calls
 * off the hot path.
 */

import { WebClient } from '@slack/web-api';
import type { FastifyBaseLogger } from 'fastify';
import type { ChannelType } from './types.js';
import type { Conversation, RawSlackMessage, SlackReader } from './poller.js';

export interface WebReaderConfig {
  userToken: string;
  /** Cap on DM conversations enumerated (bounds the poll set). */
  maxDmConversations?: number;
}

export class WebApiSlackReader implements SlackReader {
  private client: WebClient;
  private nameCache = new Map<string, string | null>();
  private maxDms: number;

  constructor(config: WebReaderConfig, private log: FastifyBaseLogger) {
    this.client = new WebClient(config.userToken);
    this.maxDms = config.maxDmConversations ?? 200;
  }

  async listDmConversations(): Promise<Conversation[]> {
    const out: Conversation[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.client.conversations.list({
        types: 'im,mpim',
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const c of res.channels ?? []) {
        if (!c.id) continue;
        out.push({ id: c.id, type: c.is_mpim ? 'mpim' : 'im' });
        if (out.length >= this.maxDms) return out;
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  async history(channel: string, oldestTs: string | null, limit: number): Promise<RawSlackMessage[]> {
    const res = await this.client.conversations.history({
      channel,
      limit,
      // `oldest` is inclusive; `inclusive:false` drops the cursor message itself
      // so we never re-process the last message we already saw.
      ...(oldestTs ? { oldest: oldestTs, inclusive: false } : {}),
    });
    return (res.messages ?? []).map((m) => ({
      ts: m.ts ?? '',
      user: m.user,
      text: m.text,
      thread_ts: m.thread_ts,
      bot_id: (m as { bot_id?: string }).bot_id,
      subtype: (m as { subtype?: string }).subtype,
    }));
  }

  async permalink(channel: string, ts: string): Promise<string | null> {
    try {
      const res = await this.client.chat.getPermalink({ channel, message_ts: ts });
      return res.permalink ?? null;
    } catch (err) {
      this.log.debug({ channel, ts, err }, 'Slack urgency: permalink fetch failed');
      return null;
    }
  }

  async userName(userId: string): Promise<string | null> {
    if (this.nameCache.has(userId)) return this.nameCache.get(userId)!;
    try {
      const res = await this.client.users.info({ user: userId });
      const p = res.user?.profile;
      const name =
        p?.display_name?.trim() ||
        p?.real_name?.trim() ||
        res.user?.name ||
        null;
      this.nameCache.set(userId, name);
      return name;
    } catch (err) {
      this.log.debug({ userId, err }, 'Slack urgency: users.info failed');
      this.nameCache.set(userId, null);
      return null;
    }
  }
}

/** ChannelType guard used by callers constructing watch-list conversations. */
export function asChannelType(v: string): ChannelType {
  return v === 'im' || v === 'mpim' || v === 'group' ? v : 'channel';
}
