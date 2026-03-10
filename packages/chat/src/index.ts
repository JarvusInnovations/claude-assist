import { createPlugin } from '@jarvus/claude-assist-core';
import { Chat } from 'chat';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createMemoryState } from '@chat-adapter/state-memory';
import { registerWebhookRoutes } from './routes.js';
import { createHariHandler } from './hari.js';
import { SessionStore } from './sessions.js';
import { join } from 'node:path';
import type { ChatPluginConfig } from '@jarvus/claude-assist-core';

export type { ChatPluginConfig } from '@jarvus/claude-assist-core';

export default createPlugin('chat', async (fastify, options) => {
  const config = options.chatConfig;

  if (!config?.slackBotToken || !config?.slackSigningSecret) {
    fastify.log.warn('Chat module enabled but SLACK_BOT_TOKEN/SIGNING_SECRET not set - skipping');
    return;
  }

  // Session store for thread→session mapping
  const sessionStore = new SessionStore(fastify.sql);

  // Create Slack adapter
  const slack = createSlackAdapter({
    botToken: config.slackBotToken,
    signingSecret: config.slackSigningSecret,
  });

  // State adapter — memory is fine since we persist sessions in postgres
  const state = createMemoryState();

  // Create bot instance
  const adapters = { slack };
  const bot = new Chat<typeof adapters, Record<string, never>>({
    userName: 'hari',
    adapters,
    state,
    logger: fastify.log.level === 'debug' || fastify.log.level === 'trace' ? 'debug' : 'info',
  });

  // Create the Agent SDK handler
  const handleMessage = createHariHandler(config, fastify.log);
  const chatConfig = config;

  /**
   * Check if this user is allowed to talk to Hari.
   * Returns true if allowed, false if not (and posts a rejection message).
   */
  async function checkAccess(thread: any, message: any): Promise<boolean> {
    if (!thread.isDM) return false;
    if (chatConfig.ownerSlackUserId && message.author.userId !== chatConfig.ownerSlackUserId) {
      await thread.post("I'm Chris's personal assistant and only respond to him.");
      return false;
    }
    return true;
  }

  /**
   * Handle a new top-level DM message.
   * Creates a new Agent SDK session and replies in a Slack thread.
   */
  async function handleNewConversation(thread: any, message: any) {
    try {
      if (!await checkAccess(thread, message)) return;

      fastify.log.info(
        { userId: message.author.userId, text: message.text.slice(0, 50) },
        'New conversation'
      );

      await thread.startTyping('Thinking...');

      const result = await handleMessage(message.text);
      fastify.log.info({ sessionId: result.sessionId, textLength: result.text.length }, 'Posting threaded response');

      // Post reply as a thread on the user's message
      // The message's raw data has the ts we need for threading
      const messageTs = message.raw?.ts ?? message.metadata?.dateSent;
      const channel = thread.id.split(':')[1]; // extract channel from slack:CHANNEL:threadTs

      if (messageTs && channel) {
        // Construct the thread ID for this new thread
        const replyThreadId = `slack:${channel}:${messageTs}`;

        // Store the session mapping
        await sessionStore.upsert(replyThreadId, result.sessionId);

        // Post via the adapter with the message ts as thread_ts
        await slack.postMessage(replyThreadId, result.text);
      } else {
        // Fallback: post as top-level (shouldn't happen)
        fastify.log.warn({ messageTs, channel }, 'Could not determine thread context, posting top-level');
        await thread.post(result.text);
      }
    } catch (err) {
      fastify.log.error({ err }, 'Error in new conversation handler');
      try {
        await thread.post("Sorry, something went wrong. Check the server logs.");
      } catch (postErr) {
        fastify.log.error({ postErr }, 'Failed to post error message');
      }
    }
  }

  /**
   * Handle a reply within an existing Slack thread.
   * Resumes the associated Agent SDK session.
   */
  async function handleThreadReply(thread: any, message: any) {
    try {
      if (!await checkAccess(thread, message)) return;

      const threadId = thread.id as string;
      const sessionId = await sessionStore.getSessionId(threadId);

      fastify.log.info(
        { threadId, sessionId, text: message.text.slice(0, 50) },
        'Thread reply'
      );

      await thread.startTyping('Thinking...');

      const result = await handleMessage(message.text, sessionId ?? undefined);

      // Update session mapping (in case session ID changed, e.g. first message in thread)
      await sessionStore.upsert(threadId, result.sessionId);

      fastify.log.info({ sessionId: result.sessionId, textLength: result.text.length }, 'Posting thread response');
      await thread.post(result.text);
    } catch (err) {
      fastify.log.error({ err }, 'Error in thread reply handler');
      try {
        await thread.post("Sorry, something went wrong. Check the server logs.");
      } catch (postErr) {
        fastify.log.error({ postErr }, 'Failed to post error message');
      }
    }
  }

  // Handle new DM messages — top-level messages start new conversations
  bot.onNewMessage(/.*/, async (thread, message) => {
    if (!thread.isDM) return;
    if (message.author.isMe) return;

    const threadId = thread.id as string;
    const threadTs = threadId.split(':')[2] ?? '';

    if (threadTs === '') {
      // Top-level DM — start new conversation with threaded reply
      await handleNewConversation(thread, message);
    } else {
      // Already in a thread — continue conversation
      await thread.subscribe();
      await handleThreadReply(thread, message);
    }
  });

  // Handle @mentions — same logic
  bot.onNewMention(async (thread, message) => {
    if (!thread.isDM) return;

    const threadId = thread.id as string;
    const threadTs = threadId.split(':')[2] ?? '';

    if (threadTs === '') {
      await handleNewConversation(thread, message);
    } else {
      await thread.subscribe();
      await handleThreadReply(thread, message);
    }
  });

  // Handle continued messages in subscribed threads
  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe) return;
    await handleThreadReply(thread, message);
  });

  // Register webhook routes
  await fastify.register(registerWebhookRoutes, { bot });

  fastify.log.info('Chat module initialized with Slack adapter');
});
