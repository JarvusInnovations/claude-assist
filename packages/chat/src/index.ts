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

  // DM handler — Hari only responds in DMs with Chris
  bot.onNewMention(async (thread, message) => {
    // Only respond in DMs
    if (!thread.isDM) {
      return;
    }

    // Only respond to Chris (if owner user ID is configured)
    if (config.ownerSlackUserId && message.author.userId !== config.ownerSlackUserId) {
      await thread.post("I'm Chris's personal assistant and only respond to him.");
      return;
    }

    await thread.subscribe();
    await thread.startTyping('Thinking...');

    const result = await handleMessage(message.text, undefined);
    await thread.setState({ sessionId: result.sessionId });
    await thread.post(result.text);
  });

  // Continue conversation in subscribed threads
  bot.onSubscribedMessage(async (thread, message) => {
    // Ignore bot's own messages
    if (message.author.isMe) return;

    // Only respond to Chris
    if (config.ownerSlackUserId && message.author.userId !== config.ownerSlackUserId) {
      return;
    }

    const threadState = await thread.state;
    await thread.startTyping('Thinking...');

    const result = await handleMessage(message.text, threadState?.sessionId);
    await thread.setState({ sessionId: result.sessionId });
    await thread.post(result.text);
  });

  // Register webhook routes
  await fastify.register(registerWebhookRoutes, { bot });

  fastify.log.info('Chat module initialized with Slack adapter');
});
