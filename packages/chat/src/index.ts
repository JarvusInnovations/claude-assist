import { App, LogLevel } from '@slack/bolt';
import { createPlugin } from '@jarvus/claude-assist-core';
import { createAgentHandler } from './agent.js';
import { SessionStore } from './sessions.js';
import type { ChatPluginConfig } from '@jarvus/claude-assist-core';

export type { ChatPluginConfig } from '@jarvus/claude-assist-core';

const SLACK_MSG_LIMIT = 3000;

export default createPlugin('chat', async (fastify, options) => {
  const config = options.chatConfig;

  if (!config?.slackBotToken || !config?.slackAppToken || !config?.slackSigningSecret) {
    fastify.log.warn('Chat module enabled but SLACK_BOT_TOKEN/APP_TOKEN/SIGNING_SECRET not set - skipping');
    return;
  }

  // config is narrowed to non-undefined after the guard above
  const chatConfig = config;
  const sessionStore = new SessionStore(fastify.sql);
  const handleMessage = createAgentHandler(chatConfig, fastify.log);

  // Map Fastify log level to Bolt log level
  const boltLogLevel = (() => {
    switch (fastify.log.level) {
      case 'trace':
      case 'debug': return LogLevel.DEBUG;
      case 'info': return LogLevel.INFO;
      case 'warn': return LogLevel.WARN;
      default: return LogLevel.ERROR;
    }
  })();

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    signingSecret: config.slackSigningSecret,
    socketMode: true,
    logLevel: boltLogLevel,
  });

  /**
   * Strip backtick-wrapped slash commands.
   * Slack intercepts bare /commands, so users send them as `/command args`
   */
  function preprocessMessage(text: string): string {
    const match = text.match(/^`(\/[^`]+)`$/);
    return match?.[1] ?? text;
  }

  /**
   * Post a response to a Slack thread. If the text exceeds the limit,
   * attach the full response as a .md file.
   */
  async function postResponse(
    channel: string,
    threadTs: string,
    text: string,
    placeholder?: { ts: string },
  ): Promise<void> {
    if (text.length <= SLACK_MSG_LIMIT) {
      if (placeholder) {
        await app.client.chat.update({
          channel,
          ts: placeholder.ts,
          text,
        });
      } else {
        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text,
        });
      }
    } else {
      // Too long — delete placeholder if present, upload file
      if (placeholder) {
        try {
          await app.client.chat.delete({ channel, ts: placeholder.ts });
        } catch {
          // Ignore delete failures
        }
      }
      await app.client.filesUploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        content: text,
        filename: 'response.md',
        initial_comment: '_(full response attached)_',
      });
    }
  }

  /**
   * Check if a message should be processed.
   */
  function shouldProcess(event: { channel_type?: string; bot_id?: string; user?: string }): boolean {
    // Only DMs
    if (event.channel_type !== 'im') return false;
    // Ignore bot messages
    if (event.bot_id) return false;
    // Owner check
    if (chatConfig.ownerSlackUserId && event.user !== chatConfig.ownerSlackUserId) return false;
    return true;
  }

  /**
   * Handle a new top-level DM (no thread_ts) — start a new conversation thread.
   */
  async function handleNewConversation(channel: string, messageTs: string, text: string) {
    fastify.log.info({ channel, text: text.slice(0, 50) }, 'New conversation');

    // Post "Thinking..." placeholder in a new thread on this message
    const placeholder = await app.client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: 'Thinking...',
    });

    const threadTs = messageTs;
    const threadKey = `${channel}:${threadTs}`;

    try {
      const result = await handleMessage(preprocessMessage(text));
      fastify.log.info({ sessionId: result.sessionId, textLength: result.text.length }, 'Posting threaded response');

      await sessionStore.upsert(threadKey, result.sessionId);
      await postResponse(channel, threadTs, result.text, placeholder.ts ? { ts: placeholder.ts } : undefined);
    } catch (err) {
      fastify.log.error({ err }, 'Error in new conversation handler');
      try {
        if (placeholder.ts) {
          await app.client.chat.update({
            channel,
            ts: placeholder.ts,
            text: 'Sorry, something went wrong. Check the server logs.',
          });
        }
      } catch (postErr) {
        fastify.log.error({ postErr }, 'Failed to post error message');
      }
    }
  }

  /**
   * Handle a reply within an existing Slack thread — resume the Agent SDK session.
   */
  async function handleThreadReply(channel: string, threadTs: string, text: string) {
    const threadKey = `${channel}:${threadTs}`;
    const sessionId = await sessionStore.getSessionId(threadKey);

    fastify.log.info({ threadKey, sessionId, text: text.slice(0, 50) }, 'Thread reply');

    // Post "Thinking..." in the thread
    const placeholder = await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: 'Thinking...',
    });

    try {
      const result = await handleMessage(preprocessMessage(text), sessionId ?? undefined);
      await sessionStore.upsert(threadKey, result.sessionId);

      fastify.log.info({ sessionId: result.sessionId, textLength: result.text.length }, 'Posting thread response');
      await postResponse(channel, threadTs, result.text, placeholder.ts ? { ts: placeholder.ts } : undefined);
    } catch (err) {
      fastify.log.error({ err }, 'Error in thread reply handler');
      try {
        if (placeholder.ts) {
          await app.client.chat.update({
            channel,
            ts: placeholder.ts,
            text: 'Sorry, something went wrong. Check the server logs.',
          });
        }
      } catch (postErr) {
        fastify.log.error({ postErr }, 'Failed to post error message');
      }
    }
  }

  // Listen for all DM messages
  app.event('message', async ({ event }) => {
    // Type guard — subtypes like message_changed, message_deleted, etc.
    if ('subtype' in event && event.subtype !== undefined) return;
    if (!shouldProcess(event)) return;

    const { channel, ts, thread_ts: threadTs, text } = event as {
      channel: string;
      ts: string;
      thread_ts?: string;
      text?: string;
    };

    if (!text) return;

    if (threadTs) {
      // Reply in existing thread
      await handleThreadReply(channel, threadTs, text);
    } else {
      // New top-level message — start new conversation
      await handleNewConversation(channel, ts, text);
    }
  });

  // Start Bolt in Socket Mode
  await app.start();
  fastify.log.info('Chat module initialized with Slack Bolt (Socket Mode)');

  // Graceful shutdown
  fastify.addHook('onClose', async () => {
    await app.stop();
  });
});
