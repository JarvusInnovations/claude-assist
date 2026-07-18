/**
 * Slack Web API reader over a USER token (xoxp-…), reading AS the owner.
 *
 * This is the production `SlackReader`. It wraps only read endpoints:
 *   conversations.list · conversations.history · search.messages · users.info
 *   · chat.getPermalink
 * The same user token the `slack-axi` CLI stores works here; supply it as
 * SLACK_URGENCY_USER_TOKEN (search.messages additionally needs the
 * `search:read` user scope). A user display name cache keeps users.info calls
 * off the hot path.
 */

import { WebClient } from '@slack/web-api';
import type { FastifyBaseLogger } from 'fastify';
import type { ChannelType } from './types.js';
import type { Conversation, MentionHit, RawSlackMessage, SlackReader } from './poller.js';

export interface WebReaderConfig {
  userToken: string;
  /** Cap on DM conversations enumerated (bounds the poll set). */
  maxDmConversations?: number;
}

export class WebApiSlackReader implements SlackReader {
  private client: WebClient;
  private nameCache = new Map<string, string | null>();
  private maxDms: number;

  constructor(config: WebReaderConfig, private log: FastifyBaseLogger, client?: WebClient) {
    this.client = client ?? new WebClient(config.userToken);
    this.maxDms = config.maxDmConversations ?? 200;
  }

  /**
   * Enumerate DM conversations, 1:1 ims first.
   *
   * A combined `types: 'im,mpim'` request is a trap: Slack returns every mpim
   * before any im, so a workspace with more mpims than `maxDms` would hit the
   * cap without a single 1:1 DM in the poll set. We therefore fetch ims and
   * mpims as separate fully-paginated passes:
   *
   *   1. ims — ALL of them, always. 1:1 DMs are the core of urgency polling
   *      and are never dropped to satisfy the cap. DMs whose counterpart
   *      account is deactivated (`is_user_deleted`) are skipped; nobody can
   *      write into those again, so polling them is pure waste.
   *   2. mpims — appended only into whatever budget `maxDms` leaves after the
   *      ims. The cap bounds mpim spend, never im coverage.
   *
   * Conversations are typed by which request produced them (mpims can carry
   * C-prefixed ids these days, so id prefixes prove nothing).
   */
  async listDmConversations(): Promise<Conversation[]> {
    const out: Conversation[] = [];

    let cursor: string | undefined;
    do {
      const res = await this.client.conversations.list({
        types: 'im',
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const c of res.channels ?? []) {
        if (!c.id || c.is_user_deleted) continue;
        out.push({ id: c.id, type: 'im' });
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);

    if (out.length >= this.maxDms) return out;

    cursor = undefined;
    do {
      const res = await this.client.conversations.list({
        types: 'mpim',
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const c of res.channels ?? []) {
        if (!c.id) continue;
        out.push({ id: c.id, type: 'mpim' });
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

  /**
   * Workspace-wide @mention lookup via `search.messages` (needs the
   * `search:read` user scope). One call, first page only, newest first — the
   * sweep cursor upstream bounds what's actually new, so paginating deeper
   * would only re-fetch mentions we've already seen. Search matches carry
   * their own permalink, so no chat.getPermalink round-trip is needed later.
   */
  async searchMentions(ownerId: string, count: number): Promise<MentionHit[]> {
    const res = await this.client.search.messages({
      query: `<@${ownerId}>`,
      sort: 'timestamp',
      sort_dir: 'desc',
      count,
    });
    const out: MentionHit[] = [];
    for (const m of res.messages?.matches ?? []) {
      const ch = m.channel;
      if (!ch?.id || !m.ts) continue;
      const channelType: ChannelType = ch.is_im
        ? 'im'
        : ch.is_mpim
          ? 'mpim'
          : ch.is_group
            ? 'group'
            : 'channel';
      out.push({
        channel: ch.id,
        channelType,
        ts: m.ts,
        user: m.user,
        text: m.text,
        bot_id: (m as { bot_id?: string }).bot_id,
        permalink: m.permalink ?? null,
      });
    }
    return out;
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
