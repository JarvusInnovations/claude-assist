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

  const SLACK_MSG_LIMIT = 2800; // Slack limit is ~4000 but mrkdwn conversion expands text, and chat.update has a lower limit

  /**
   * Strip backtick-wrapped slash commands.
   * Slack intercepts bare /commands, so users send them as `/command args`
   */
  function preprocessMessage(text: string): string {
    const match = text.match(/^`(\/[^`]+)`$/);
    return match?.[1] ?? text;
  }

  /**
   * Post a response, attaching a text file if it exceeds Slack's message limit.
   */
  async function postResponse(target: { postMessage: (threadId: string, msg: any) => Promise<any> } | any, threadId: string | null, text: string, isEdit?: { messageId: string }) {
    if (text.length <= SLACK_MSG_LIMIT) {
      // Short enough — post or edit directly
      if (isEdit && threadId) {
        await slack.editMessage(threadId, isEdit.messageId, text);
      } else if (threadId) {
        await slack.postMessage(threadId, text);
      } else {
        await target.post(text);
      }
      return;
    }

    // Too long — post a truncated message + full response as text file
    const truncated = text.slice(0, SLACK_MSG_LIMIT - 200) + '\n\n_(full response attached as file)_';
    const file = {
      data: Buffer.from(text, 'utf-8'),
      filename: 'response.md',
      mimeType: 'text/markdown',
    };

    if (isEdit && threadId) {
      await slack.editMessage(threadId, isEdit.messageId, truncated);
      // Post file as a follow-up in the same thread
      await slack.postMessage(threadId, { markdown: '', files: [file] });
    } else if (threadId) {
      await slack.postMessage(threadId, { markdown: truncated, files: [file] });
    } else {
      await target.post(truncated);
      // Can't attach files via thread.post — fall back to just truncated
    }
  }

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

      const result = await handleMessage(preprocessMessage(message.text));
      fastify.log.info({ sessionId: result.sessionId, textLength: result.text.length }, 'Posting threaded response');

      if (messageTs && channel) {
        const replyThreadId = `slack:${channel}:${messageTs}`;

        // Store the session mapping
        await sessionStore.upsert(replyThreadId, result.sessionId);

        // Edit the placeholder with the actual response (or post + attach file if too long)
        await postResponse(
          slack, replyThreadId, result.text,
          placeholderMsg ? { messageId: placeholderMsg.id } : undefined
        );
      } else {
        fastify.log.warn({ messageTs, channel }, 'Could not determine thread context, posting top-level');
        await postResponse(thread, null, result.text);
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

      const result = await handleMessage(preprocessMessage(message.text), sessionId ?? undefined);

      // Update session mapping (in case session ID changed, e.g. first message in thread)
      await sessionStore.upsert(threadId, result.sessionId);

      fastify.log.info({ sessionId: result.sessionId, textLength: result.text.length }, 'Posting thread response');
      const threadId2 = thread.id as string;
      await postResponse(slack, threadId2, result.text);
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
