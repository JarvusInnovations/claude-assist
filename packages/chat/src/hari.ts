import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { ChatPluginConfig } from '@jarvus/claude-assist-core';

export interface HariResult {
  text: string;
  sessionId: string;
}

/**
 * Creates a handler that bridges Slack messages to the Agent SDK.
 * Each call to the returned function runs a query() against Claude Code
 * with Hari's full context (CLAUDE.md, skills, MCP servers).
 */
/**
 * Load env vars from settings.local.json so MCP servers get their API keys.
 * Providing env to the Agent SDK overrides settings.local.json env,
 * so we need to merge them ourselves.
 */
function loadSettingsEnv(hariRepoPath: string, log: FastifyBaseLogger): Record<string, string> {
  try {
    const settingsPath = join(hariRepoPath, '.claude', 'settings.local.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return settings.env ?? {};
  } catch (err) {
    log.warn({ err }, 'Could not load settings.local.json env');
    return {};
  }
}

export function createHariHandler(config: ChatPluginConfig, log: FastifyBaseLogger) {
  // Load MCP env vars once at startup
  const settingsEnv = loadSettingsEnv(config.hariRepoPath, log);
  log.info({ envKeys: Object.keys(settingsEnv) }, 'Loaded settings.local.json env vars');

  return async function handleMessage(
    userText: string,
    resumeSessionId?: string,
  ): Promise<HariResult> {
    let sessionId = '';
    let resultText = '';

    log.info({ resumeSessionId, promptLength: userText.length }, 'Starting Agent SDK query');

    // Build env: system essentials + settings.local.json env + OAuth token
    // Don't pass ANTHROPIC_API_KEY so Agent SDK uses OAuth token
    const agentEnv: Record<string, string> = {
      HOME: process.env.HOME ?? '',
      PATH: process.env.PATH ?? '',
      SHELL: process.env.SHELL ?? '/bin/bash',
      USER: process.env.USER ?? '',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      TERM: process.env.TERM ?? 'xterm-256color',
      ...settingsEnv,
      ...(config.claudeOauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: config.claudeOauthToken } : {}),
    };

    try {
      for await (const message of query({
        prompt: userText,
        options: {
          cwd: config.hariRepoPath,
          settingSources: ['project'],
          env: agentEnv,
          allowedTools: [
            'Read', 'Write', 'Edit', 'Glob', 'Grep',
            'WebSearch', 'WebFetch',
            'Bash', 'Agent',
            'mcp__*',  // Allow all MCP tools (deny list in settings.json still applies)
          ],
          permissionMode: 'bypassPermissions',
          maxTurns: 30,
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
          ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
        },
      })) {
        // Capture session ID from init message
        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = (message as { session_id?: string }).session_id ?? '';
          log.debug({ sessionId }, 'Agent SDK session initialized');
        }

        // Capture result
        if (message.type === 'result') {
          const result = message as { session_id?: string; result?: string; subtype?: string };
          sessionId = result.session_id ?? sessionId;
          resultText = result.result ?? '';
          log.info(
            { sessionId, subtype: result.subtype, resultLength: resultText.length },
            'Agent SDK query completed'
          );
        }
      }
    } catch (err) {
      // The Agent SDK process may exit with code 1 after delivering a successful result.
      // Only show error to user if we didn't already get a result.
      if (resultText) {
        log.warn({ err, sessionId }, 'Agent SDK process exited with error after successful result');
      } else {
        log.error({ err, resumeSessionId }, 'Agent SDK query failed');
        resultText = "Sorry, I hit an error processing that. Let me know if you'd like me to try again.";
      }
    }

    return { text: resultText, sessionId };
  };
}
