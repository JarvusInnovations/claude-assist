import { App, LogLevel } from '@slack/bolt';
import { markdownToBlocks } from '@tryfabric/mack';
import { createPlugin } from '@jarvus/claude-assist-core';
import { createAgentHandler } from './agent.js';
import { SessionStore } from './sessions.js';
import type { ChatPluginConfig } from '@jarvus/claude-assist-core';

export type { ChatPluginConfig } from '@jarvus/claude-assist-core';

const THREAD_TITLE_MAX = 60;

// TODO: make suggested prompts dynamic based on conversation context
// const SUGGESTED_PROMPTS = [
//   { title: 'Daily briefing', message: '`/briefing`' },
//   { title: 'Check commitments', message: '`/commitments`' },
//   { title: 'What\'s next?', message: '`/next`' },
// ];

export default createPlugin('chat', async (fastify, options) => {
  const config = options.chatConfig;

  if (!config?.slackBotToken || !config?.slackAppToken || !config?.slackSigningSecret) {
    fastify.log.warn('Chat module enabled but SLACK_BOT_TOKEN/APP_TOKEN/SIGNING_SECRET not set - skipping');
    return;
  }

  if (!config.ownerSlackUserId) {
    fastify.log.error('SLACK_OWNER_USER_ID is required — the chat module uses bypassPermissions and must restrict access to a single user');
    return;
  }

  if (!config.agentRepoPath) {
    fastify.log.error('AGENT_REPO_PATH is required — the agent needs a working directory with CLAUDE.md and skills');
    return;
  }

  const chatConfig = config;
  const sessionStore = new SessionStore(fastify.sql);
  const handleMessage = createAgentHandler(chatConfig, fastify.log);

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
   * Add a reaction to a message. Fails silently.
   */
  async function addReaction(channel: string, timestamp: string, name: string) {
    try {
      await app.client.reactions.add({ channel, timestamp, name });
    } catch {
      // Ignore — reaction may already exist or scope missing
    }
  }

  /**
   * Remove a reaction from a message. Fails silently.
   */
  async function removeReaction(channel: string, timestamp: string, name: string) {
    try {
      await app.client.reactions.remove({ channel, timestamp, name });
    } catch {
      // Ignore
    }
  }

  /**
   * Set the assistant typing status in a thread. Fails silently.
   */
  async function setTypingStatus(channel: string, threadTs: string, status: string) {
    try {
      await app.client.assistant.threads.setStatus({
        channel_id: channel,
        thread_ts: threadTs,
        status,
      });
    } catch {
      // Ignore — assistant feature may not be enabled
    }
  }

  /**
   * Set suggested prompts in a thread. Fails silently.
   */
  // TODO: make suggested prompts dynamic based on conversation context
  // async function setSuggestedPrompts(channel: string, threadTs: string) {
  //   try {
  //     await app.client.assistant.threads.setSuggestedPrompts({
  //       channel_id: channel,
  //       thread_ts: threadTs,
  //       prompts: SUGGESTED_PROMPTS,
  //     });
  //   } catch {
  //     // Ignore
  //   }
  // }

  /**
   * Set a title for a thread. Fails silently.
   */
  async function setThreadTitle(channel: string, threadTs: string, title: string) {
    try {
      const truncated = title.length > THREAD_TITLE_MAX
        ? title.slice(0, THREAD_TITLE_MAX - 1) + '…'
        : title;
      await app.client.assistant.threads.setTitle({
        channel_id: channel,
        thread_ts: threadTs,
        title: truncated,
      });
    } catch {
      // Ignore
    }
  }

  /**
   * Post a response to a Slack thread. If the text exceeds the limit,
   * attach the full response as a .md file.
   */
  /**
   * Split blocks into chunks that respect Slack constraints:
   * - Max 50 blocks per message
   * - Max 1 table per message
   */
  function chunkBlocks(blocks: Awaited<ReturnType<typeof markdownToBlocks>>): typeof blocks[] {
    const chunks: typeof blocks[] = [];
    let current: typeof blocks = [];

    for (const block of blocks) {
      const isTable = (block as { type: string }).type === 'table';
      const currentHasTable = current.some(b => (b as { type: string }).type === 'table');

      // Start new chunk if adding this block would violate constraints
      if (current.length >= 50 || (isTable && currentHasTable)) {
        if (current.length > 0) chunks.push(current);
        current = [];
      }

      current.push(block);

      // If we just added a table, flush after it so next table gets its own chunk
      if (isTable) {
        chunks.push(current);
        current = [];
      }
    }

    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  async function postResponse(channel: string, threadTs: string, text: string): Promise<void> {
    const blocks = await markdownToBlocks(text);
    const chunks = chunkBlocks(blocks);

    for (let i = 0; i < chunks.length; i++) {
      try {
        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          blocks: chunks[i],
          text: i === 0 ? text.slice(0, 3000) : '(continued)',
        });
      } catch (err: any) {
        // If blocks are rejected, fall back to plain text for this chunk
        if (err?.data?.error === 'invalid_blocks') {
          fastify.log.warn({ errors: err.data.errors }, 'Slack rejected blocks, falling back to text');
          const chunk = chunks[i]!;
          const fallbackText = chunk
            .map(b => {
              const block = b as unknown as Record<string, unknown>;
              const textObj = block.text as { text?: string } | undefined;
              return textObj?.text ?? '';
            })
            .filter(Boolean)
            .join('\n\n');
          await app.client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: fallbackText || text.slice(0, 3000),
          });
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Check if a message should be processed.
   */
  function shouldProcess(event: { channel_type?: string; bot_id?: string; user?: string }): boolean {
    if (event.channel_type !== 'im') return false;
    if (event.bot_id) return false;
    if (event.user !== chatConfig.ownerSlackUserId) return false;
    return true;
  }

  /**
   * Handle a new top-level DM — start a new conversation thread.
   */
  async function handleNewConversation(channel: string, messageTs: string, text: string) {
    fastify.log.info({ channel, text: text.slice(0, 50) }, 'New conversation');

    // Instant feedback
    await addReaction(channel, messageTs, 'thinking_face');
    // Set typing status on the thread (messageTs becomes the thread_ts)
    await setTypingStatus(channel, messageTs, 'Thinking...');

    try {
      const result = await handleMessage(preprocessMessage(text), undefined, {
        onStatus: (status) => setTypingStatus(channel, messageTs, status),
      });
      fastify.log.info({ sessionId: result.sessionId, textLength: result.text.length }, 'Posting threaded response');

      const threadTs = messageTs;
      const threadKey = `${channel}:${threadTs}`;
      await sessionStore.upsert(threadKey, result.sessionId);

      await postResponse(channel, threadTs, result.text);
      await setThreadTitle(channel, threadTs, text);
      // await setSuggestedPrompts(channel, threadTs);
    } catch (err) {
      fastify.log.error({ err }, 'Error in new conversation handler');
      try {
        await app.client.chat.postMessage({
          channel,
          thread_ts: messageTs,
          text: 'Sorry, something went wrong. Check the server logs.',
        });
      } catch (postErr) {
        fastify.log.error({ postErr }, 'Failed to post error message');
      }
    } finally {
      await removeReaction(channel, messageTs, 'thinking_face');
    }
  }

  /**
   * Handle a reply within an existing Slack thread — resume the Agent SDK session.
   */
  async function handleThreadReply(channel: string, threadTs: string, messageTs: string, text: string) {
    const threadKey = `${channel}:${threadTs}`;
    const sessionId = await sessionStore.getSessionId(threadKey);

    fastify.log.info({ threadKey, sessionId, text: text.slice(0, 50) }, 'Thread reply');

    // Instant feedback
    await addReaction(channel, messageTs, 'thinking_face');
    await setTypingStatus(channel, threadTs, 'Thinking...');

    try {
      const result = await handleMessage(preprocessMessage(text), sessionId ?? undefined, {
        onStatus: (status) => setTypingStatus(channel, threadTs, status),
      });
      await sessionStore.upsert(threadKey, result.sessionId);

      fastify.log.info({ sessionId: result.sessionId, textLength: result.text.length }, 'Posting thread response');
      await postResponse(channel, threadTs, result.text);
      // await setSuggestedPrompts(channel, threadTs);
    } catch (err) {
      fastify.log.error({ err }, 'Error in thread reply handler');
      try {
        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: 'Sorry, something went wrong. Check the server logs.',
        });
      } catch (postErr) {
        fastify.log.error({ postErr }, 'Failed to post error message');
      }
    } finally {
      await removeReaction(channel, messageTs, 'thinking_face');
    }
  }

  // Listen for all DM messages
  app.event('message', async ({ event }) => {
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
      await handleThreadReply(channel, threadTs, ts, text);
    } else {
      await handleNewConversation(channel, ts, text);
    }
  });

  // Start Bolt in Socket Mode (non-blocking — don't hold up server boot)
  app.start().then(
    () => fastify.log.info('Slack Bolt connected (Socket Mode)'),
    (err) => fastify.log.error({ err }, 'Slack Bolt failed to connect'),
  );

  // Graceful shutdown
  fastify.addHook('onClose', async () => {
    await app.stop();
  });
});
