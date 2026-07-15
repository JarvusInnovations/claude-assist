import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildContextHook } from './context.js';
import type { FastifyBaseLogger } from 'fastify';
import type { ChatPluginConfig } from '@jarvus/claude-assist-core';

export interface AgentResult {
  text: string;
  sessionId: string;
}

export interface AgentHandlerOptions {
  /** Called with a human-readable status when the agent starts a tool or subagent */
  onStatus?: (status: string) => void;
}

/** Map tool names to human-readable descriptions */
const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading file',
  Write: 'Writing file',
  Edit: 'Editing file',
  Glob: 'Searching files',
  Grep: 'Searching code',
  Bash: 'Running command',
  WebSearch: 'Searching the web',
  WebFetch: 'Fetching page',
  Agent: 'Working with subagent',
};

function describeToolUse(toolName: string, input: Record<string, unknown>): string {
  // MCP tools: mcp__server__tool → "Using server tool"
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const server = parts[1] ?? 'mcp';
    const tool = parts[2] ?? 'tool';
    return `Using ${server}: ${tool}`;
  }

  const label = TOOL_LABELS[toolName] ?? `Using ${toolName}`;

  // Add context from input where helpful
  if (toolName === 'Read' && typeof input.file_path === 'string') {
    const filename = input.file_path.split('/').pop();
    return `Reading ${filename}`;
  }
  if (toolName === 'Edit' && typeof input.file_path === 'string') {
    const filename = input.file_path.split('/').pop();
    return `Editing ${filename}`;
  }
  if (toolName === 'Write' && typeof input.file_path === 'string') {
    const filename = input.file_path.split('/').pop();
    return `Writing ${filename}`;
  }
  if (toolName === 'Bash' && typeof input.command === 'string') {
    const cmd = input.command.slice(0, 40);
    return `Running: ${cmd}${input.command.length > 40 ? '...' : ''}`;
  }
  if (toolName === 'WebSearch' && typeof input.query === 'string') {
    return `Searching: ${input.query.slice(0, 40)}`;
  }
  if (toolName === 'Grep' && typeof input.pattern === 'string') {
    return `Searching for: ${input.pattern.slice(0, 40)}`;
  }

  return label;
}

/**
 * Load env vars from settings.local.json so MCP servers get their API keys.
 * Providing env to the Agent SDK overrides settings.local.json env,
 * so we need to merge them ourselves.
 */
function loadSettingsEnv(repoPath: string, log: FastifyBaseLogger): Record<string, string> {
  try {
    const settingsPath = join(repoPath, '.claude', 'settings.local.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return settings.env ?? {};
  } catch (err) {
    log.warn({ err }, 'Could not load settings.local.json env');
    return {};
  }
}

/**
 * Creates a handler that bridges chat messages to the Claude Agent SDK.
 * Each call to the returned function runs a query() against Claude Code
 * with the agent's full context (CLAUDE.md, skills, MCP servers).
 */
export function createAgentHandler(config: ChatPluginConfig, log: FastifyBaseLogger) {
  // Load MCP env vars once at startup
  const settingsEnv = loadSettingsEnv(config.agentRepoPath, log);
  log.info({ envKeys: Object.keys(settingsEnv) }, 'Loaded settings.local.json env vars');

  return async function handleMessage(
    userText: string,
    resumeSessionId?: string,
    options?: AgentHandlerOptions,
  ): Promise<AgentResult> {
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
          cwd: config.agentRepoPath,
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
          // Inject live context (dashboards, status views) on every turn.
          // cwd matters here: context commands run in the agent repo so
          // version-manager shims resolve tool versions per-directory.
          ...(config.contextCommands && config.contextCommands.length > 0
            ? {
                hooks: {
                  UserPromptSubmit: [
                    buildContextHook(config.contextCommands, agentEnv, config.agentRepoPath),
                  ],
                },
              }
            : {}),
        },
      })) {
        // Capture session ID from init message
        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = (message as { session_id?: string }).session_id ?? '';
          log.debug({ sessionId }, 'Agent SDK session initialized');
        }

        // Emit status on assistant messages containing tool_use
        if (message.type === 'assistant' && options?.onStatus) {
          const assistantMsg = message as { message?: { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } };
          const toolUses = assistantMsg.message?.content?.filter(block => block.type === 'tool_use') ?? [];
          for (const toolUse of toolUses) {
            if (toolUse.name) {
              const status = describeToolUse(toolUse.name, toolUse.input ?? {});
              log.debug({ tool: toolUse.name, status }, 'Tool use status');
              options.onStatus(status);
            }
          }
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
