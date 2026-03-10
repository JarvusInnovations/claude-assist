import { createPlugin } from '@jarvus/claude-assist-core';
import { Chat } from 'chat';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createMemoryState } from '@chat-adapter/state-memory';
import { registerWebhookRoutes } from './routes.js';
import { createHariHandler } from './hari.js';
import type { ChatPluginConfig } from '@jarvus/claude-assist-core';

export type { ChatPluginConfig } from '@jarvus/claude-assist-core';

export default createPlugin('chat', async (fastify, options) => {
  const config = options.chatConfig;

  if (!config?.slackBotToken || !config?.slackSigningSecret) {
    fastify.log.warn('Chat module enabled but SLACK_BOT_TOKEN/SIGNING_SECRET not set - skipping');
    return;
  }

  // Create Slack adapter
  const slack = createSlackAdapter({
    botToken: config.slackBotToken,
    signingSecret: config.slackSigningSecret,
  });

  // State adapter — start with memory, upgrade to pg/redis later
  const state = createMemoryState();

  // Thread state tracks Agent SDK session IDs
  interface ThreadState {
    sessionId?: string;
  }

  // Create bot instance
  const adapters = { slack };
  const bot = new Chat<typeof adapters, ThreadState>({
    userName: 'hari',
    adapters,
    state,
    logger: fastify.log.level === 'debug' || fastify.log.level === 'trace' ? 'debug' : 'info',
  });

  // Create the Agent SDK handler
  const handleMessage = createHariHandler(config, fastify.log);

  // Capture config as non-nullable (we already checked above)
  const chatConfig = config;

  // Shared handler for processing a message and posting the response
  async function processMessage(thread: any, message: any, resumeSessionId?: string) {
    try {
      fastify.log.info(
        { isDM: thread.isDM, userId: message.author.userId, text: message.text.slice(0, 50) },
        'Processing message'
      );

      // Only respond in DMs
      if (!thread.isDM) {
        fastify.log.info('Ignoring non-DM message');
        return;
      }

      // Only respond to Chris (if owner user ID is configured)
      if (chatConfig.ownerSlackUserId && message.author.userId !== chatConfig.ownerSlackUserId) {
        await thread.post("I'm Chris's personal assistant and only respond to him.");
        return;
      }

      await thread.startTyping('Thinking...');

      const result = await handleMessage(message.text, resumeSessionId);
      fastify.log.info({ sessionId: result.sessionId, textLength: result.text.length }, 'Posting response to Slack');
      await thread.setState({ sessionId: result.sessionId });
      await thread.post(result.text);
    } catch (err) {
      fastify.log.error({ err }, 'Error in message handler');
      try {
        await thread.post("Sorry, something went wrong. Check the server logs.");
      } catch (postErr) {
        fastify.log.error({ postErr }, 'Failed to post error message to Slack');
      }
    }
  }

  // Handle @mentions in DMs — subscribe and process
  bot.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await processMessage(thread, message);
  });

  // Handle all messages in subscribed threads
  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe) return;
    const threadState = await thread.state;
    await processMessage(thread, message, threadState?.sessionId);
  });

  // Handle plain DM messages (no @mention needed)
  bot.onNewMessage(/.*/, async (thread, message) => {
    if (!thread.isDM) return;
    if (message.author.isMe) return;
    await thread.subscribe();
    await processMessage(thread, message);
  });

  // Register webhook routes
  await fastify.register(registerWebhookRoutes, { bot });

  fastify.log.info('Chat module initialized with Slack adapter');
});
