/**
 * Slack DM channel — Hari's personal Slack presence (distinct from team-side
 * JarvBot per the personal/team firewall). Reuses the chat module's bot token
 * to DM the owner directly. The digest tier batches into a single DM.
 */

import { WebClient } from '@slack/web-api';

export interface SlackDmConfig {
  botToken: string;
  ownerUserId: string;
}

export interface SlackMessage {
  title: string;
  body: string;
  url?: string;
}

export interface SlackChannel {
  send(msg: SlackMessage): Promise<void>;
  sendDigest(items: string[]): Promise<void>;
}

function formatOne({ title, body, url }: SlackMessage): string {
  const link = url ? `\n<${url}|Open>` : '';
  return `*${title}*\n${body}${link}`;
}

export function createSlackChannel(config: SlackDmConfig): SlackChannel {
  // Passing a user id as `channel` posts to that user's DM with the bot.
  const client = new WebClient(config.botToken);

  return {
    async send(msg) {
      await client.chat.postMessage({
        channel: config.ownerUserId,
        text: formatOne(msg),
        mrkdwn: true,
        unfurl_links: false,
      });
    },

    async sendDigest(items) {
      const header = `*Digest* — ${items.length} item${items.length === 1 ? '' : 's'}`;
      await client.chat.postMessage({
        channel: config.ownerUserId,
        text: `${header}\n\n${items.join('\n\n')}`,
        mrkdwn: true,
        unfurl_links: false,
      });
    },
  };
}
