import { createPlugin } from '@jarvus/claude-assist-core';
import { Chat } from 'chat';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createMemoryState } from '@chat-adapter/state-memory';
import { registerWebhookRoutes } from './routes.js';
import { createAgentHandler } from './agent.js';
import { SessionStore } from './sessions.js';
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
    userName: config.botUsername ?? 'assistant',
    adapters,
    state,
    logger: fastify.log.level === 'debug' || fastify.log.level === 'trace' ? 'debug' : 'info',
  });

  // Create the Agent SDK handler
  const handleMessage = createAgentHandler(config, fastify.log);
  const chatConfig = config;

  /**
   * Check if this user is allowed to talk to the agent.
   * Returns true if allowed, false if not (and posts a rejection message).
   */
  async function checkAccess(thread: any, message: any): Promise<boolean> {
    if (!thread.isDM) return false;
    if (chatConfig.ownerSlackUserId && message.author.userId !== chatConfig.ownerSlackUserId) {
      await thread.post("I only respond to my owner.");
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

      // Post a "Thinking..." placeholder in the thread immediately
      const messageTs = message.raw?.ts ?? message.metadata?.dateSent;
      const channel = thread.id.split(':')[1]; // extract channel from slack:CHANNEL:threadTs

      let placeholderMsg: { id: string; threadId: string } | null = null;
      if (messageTs && channel) {
        const replyThreadId = `slack:${channel}:${messageTs}`;
        placeholderMsg = await slack.postMessage(replyThreadId, 'Thinking...');
      }

      const result = await handleMessage(message.text);
      fastify.log.info({ sessionId: result.sessionId, textLength: result.text.length }, 'Posting threaded response');

      if (messageTs && channel) {
        const replyThreadId = `slack:${channel}:${messageTs}`;

        // Store the session mapping
        await sessionStore.upsert(replyThreadId, result.sessionId);

        // Edit the placeholder with the actual response
        if (placeholderMsg) {
          await slack.editMessage(replyThreadId, placeholderMsg.id, result.text);
        } else {
          await slack.postMessage(replyThreadId, result.text);
        }
      } else {
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
