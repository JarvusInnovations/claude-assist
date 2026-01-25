import Anthropic from '@anthropic-ai/sdk';
import pLimit from 'p-limit';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { TranscriptMessage, ContentBlock, ToolUseBlock } from './types.js';

export interface OutlineServiceConfig {
  concurrency?: number; // Default: 5
  apiKey?: string; // Default: process.env.ANTHROPIC_API_KEY
  model?: string; // Default: 'claude-haiku-4-5'
  maxTokens?: number; // Default: 1024
}

export interface OutlineProgress {
  completed: number;
  total: number;
  currentSession: string | null;
  errors: number;
  isRunning: boolean;
}

export interface OutlineResult {
  sessionsProcessed: number;
  outlinesGenerated: number;
  skipped: number;
  errors: string[];
}

interface SessionForOutline {
  id: string;
  project_path: string | null;
  git_branch: string | null;
  raw_transcript: string;
  transcript_hash: string;
  outline: string | null;
  outline_hash: string | null;
  output_tokens: string;
}

/**
 * Service for generating AI outlines of sessions using Claude Haiku
 * Uses p-limit for concurrency control
 */
export class OutlineService {
  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private client: Anthropic;
  private limit: ReturnType<typeof pLimit>;
  private model: string;
  private maxTokens: number;
  private progress: OutlineProgress;

  constructor(
    sql: postgres.Sql,
    log: FastifyBaseLogger,
    config: OutlineServiceConfig = {}
  ) {
    this.sql = sql;
    this.log = log;
    this.model = config.model ?? 'claude-haiku-4-5';
    this.maxTokens = config.maxTokens ?? 1024;

    // Initialize Anthropic client
    const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable required');
    }
    this.client = new Anthropic({ apiKey });

    // Initialize concurrency limiter
    this.limit = pLimit(config.concurrency ?? 5);

    // Initialize progress tracking
    this.progress = {
      completed: 0,
      total: 0,
      currentSession: null,
      errors: 0,
      isRunning: false,
    };
  }

  /**
   * Get current progress for status reporting
   */
  getProgress(): OutlineProgress {
    return { ...this.progress };
  }

  /**
   * Serialize raw JSONL transcript to token-efficient format
   * Format: [U] user message, [A] assistant snippet, [T] tool + target
   */
  serializeTranscript(rawTranscript: string): string {
    const lines = rawTranscript.trim().split('\n');
    const output: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const msg: TranscriptMessage = JSON.parse(line);

        // Skip queue operations
        if (msg.type === 'queue-operation') continue;

        if (msg.type === 'user' && msg.message) {
          const text = this.extractTextContent(msg.message.content);
          if (text) {
            output.push(`[U] ${text}`);
          }
        }

        if (msg.type === 'assistant' && msg.message) {
          // Extract brief text snippet (first ~100 chars)
          const text = this.extractTextContent(msg.message.content);
          if (text) {
            const snippet =
              text.length > 100 ? text.slice(0, 100) + '...' : text;
            output.push(`[A] ${snippet}`);
          }

          // Extract tool calls
          const tools = this.extractToolUses(msg.message.content);
          for (const tool of tools) {
            const target = this.extractToolTarget(tool);
            output.push(`[T] ${tool.name}${target ? ' ' + target : ''}`);
          }
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    const result = output.join('\n');

    // Truncate to stay within Haiku's 200K token context
    // Reserve ~2K tokens for response + prompt overhead, leaving ~198K for transcript
    // At ~3.5 chars/token (conservative for code): 198K × 3.5 ≈ 693K chars
    const MAX_TRANSCRIPT_CHARS = 680000;
    if (result.length > MAX_TRANSCRIPT_CHARS) {
      return (
        result.slice(0, MAX_TRANSCRIPT_CHARS) + '\n[...transcript truncated]'
      );
    }

    return result;
  }

  /**
   * Extract text content from message content
   */
  private extractTextContent(content: string | ContentBlock[]): string {
    if (typeof content === 'string') {
      return content;
    }

    return content
      .filter(
        (block): block is { type: 'text'; text: string } => block.type === 'text'
      )
      .map((block) => block.text)
      .join('\n');
  }

  /**
   * Extract tool use blocks from message content
   */
  private extractToolUses(content: string | ContentBlock[]): ToolUseBlock[] {
    if (typeof content === 'string') {
      return [];
    }

    return content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use'
    );
  }

  /**
   * Extract primary target from tool input (file path, command, etc.)
   */
  private extractToolTarget(tool: ToolUseBlock): string | null {
    const input = tool.input;
    if (!input || typeof input !== 'object') return null;

    const inputObj = input as Record<string, unknown>;

    // File path keys
    const pathKeys = [
      'file_path',
      'path',
      'file',
      'filename',
      'filePath',
      'notebook_path',
    ];
    for (const key of pathKeys) {
      const value = inputObj[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }

    // Command for Bash
    if (tool.name === 'Bash' && typeof inputObj.command === 'string') {
      const cmd = inputObj.command;
      return cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd;
    }

    // Pattern for search tools
    if (typeof inputObj.pattern === 'string') {
      return inputObj.pattern;
    }

    // Query for search tools
    if (typeof inputObj.query === 'string') {
      return inputObj.query;
    }

    return null;
  }

  /**
   * Build the prompt for outline generation
   */
  private buildPrompt(
    projectPath: string | null,
    gitBranch: string | null,
    serializedTranscript: string
  ): string {
    return `Summarize this Claude Code session.

SESSION:
- Project: ${projectPath ?? 'unknown'}
- Branch: ${gitBranch ?? 'unknown'}

TRANSCRIPT:
${serializedTranscript}

Respond with exactly this format:
<output_example>
Task: [1-2 sentence description of what the user wanted to accomplish]

Outcome: [1-2 sentence summary of what was accomplished or the result]

- [key topic or task covered]
- [key topic or task covered]
</output_example>`;
  }

  /**
   * Parse the outline response - extract from output_example tags if present
   */
  private parseOutlineResponse(response: string): string {
    // Extract content from output_example tags if present
    const match = response.match(/<output_example>([\s\S]*?)<\/output_example>/);
    if (match?.[1]) {
      return match[1].trim();
    }

    // Otherwise return response as-is
    return response.trim();
  }

  /**
   * Generate outline for a single session
   */
  async generateOutline(session: SessionForOutline): Promise<string> {
    const serializedTranscript = this.serializeTranscript(session.raw_transcript);
    const prompt = this.buildPrompt(
      session.project_path,
      session.git_branch,
      serializedTranscript
    );

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    // Extract text from response
    const textBlock = response.content.find((block) => block.type === 'text');
    const rawOutline = textBlock?.type === 'text' ? textBlock.text : '';

    return this.parseOutlineResponse(rawOutline);
  }

  /**
   * Process sessions that need outline generation (async/non-blocking)
   * Returns immediately, processing happens in background
   */
  async queueOutlineGeneration(sessionIds?: string[]): Promise<void> {
    if (this.progress.isRunning) {
      this.log.info('Outline generation already in progress, skipping');
      return;
    }

    // Mark as running immediately to prevent race conditions
    this.progress.isRunning = true;

    // Find sessions needing outlines
    let sessions: SessionForOutline[];
    if (sessionIds && sessionIds.length > 0) {
      sessions = await this.sql<SessionForOutline[]>`
        SELECT id, project_path, git_branch, raw_transcript, transcript_hash, outline, outline_hash, output_tokens
        FROM sessions.sessions
        WHERE id = ANY(${sessionIds}::uuid[])
          AND outline_hash IS DISTINCT FROM transcript_hash
      `;
    } else {
      sessions = await this.sql<SessionForOutline[]>`
        SELECT id, project_path, git_branch, raw_transcript, transcript_hash, outline, outline_hash, output_tokens
        FROM sessions.sessions
        WHERE outline_hash IS DISTINCT FROM transcript_hash
        ORDER BY started_at DESC
        LIMIT 100
      `;
    }

    if (sessions.length === 0) {
      this.log.info('No sessions need outline generation');
      this.progress.isRunning = false;
      return;
    }

    // Reset progress
    this.progress = {
      completed: 0,
      total: sessions.length,
      currentSession: null,
      errors: 0,
      isRunning: true,
    };

    this.log.info({ count: sessions.length }, 'Queuing outline generation');

    // Queue all sessions with concurrency limit (non-blocking)
    const promises = sessions.map((session) =>
      this.limit(async () => {
        try {
          this.progress.currentSession = session.id;

          // Skip API call for sessions with no assistant output
          const outline =
            session.output_tokens === '0'
              ? null
              : await this.generateOutline(session);

          // Store the outline (null for empty sessions)
          await this.sql`
            UPDATE sessions.sessions
            SET outline = ${outline},
                outline_hash = ${session.transcript_hash}
            WHERE id = ${session.id}::uuid
          `;

          this.progress.completed++;
          this.log.debug(
            { sessionId: session.id, skipped: session.output_tokens === '0' },
            outline ? 'Generated outline' : 'Skipped empty session'
          );
        } catch (error) {
          this.progress.errors++;
          this.log.error(
            { error, sessionId: session.id },
            'Failed to generate outline'
          );
        }
      })
    );

    // Don't await - let it run in background
    Promise.all(promises)
      .then(() => {
        this.progress.currentSession = null;
        this.progress.isRunning = false;
        this.log.info(
          {
            completed: this.progress.completed,
            errors: this.progress.errors,
          },
          'Outline generation batch complete'
        );
      })
      .catch((error) => {
        this.progress.isRunning = false;
        this.log.error({ error }, 'Outline generation batch failed');
      });
  }

  /**
   * Generate outlines synchronously (blocking, for manual triggers)
   */
  async generateOutlinesSync(sessionIds?: string[]): Promise<OutlineResult> {
    const result: OutlineResult = {
      sessionsProcessed: 0,
      outlinesGenerated: 0,
      skipped: 0,
      errors: [],
    };

    // Find sessions needing outlines
    let sessions: SessionForOutline[];
    if (sessionIds && sessionIds.length > 0) {
      sessions = await this.sql<SessionForOutline[]>`
        SELECT id, project_path, git_branch, raw_transcript, transcript_hash, outline, outline_hash, output_tokens
        FROM sessions.sessions
        WHERE id = ANY(${sessionIds}::uuid[])
      `;
    } else {
      sessions = await this.sql<SessionForOutline[]>`
        SELECT id, project_path, git_branch, raw_transcript, transcript_hash, outline, outline_hash, output_tokens
        FROM sessions.sessions
        WHERE outline_hash IS DISTINCT FROM transcript_hash
        ORDER BY started_at DESC
        LIMIT 100
      `;
    }

    result.sessionsProcessed = sessions.length;

    // Reset progress
    this.progress = {
      completed: 0,
      total: sessions.length,
      currentSession: null,
      errors: 0,
      isRunning: true,
    };

    // Process with concurrency limit
    const promises = sessions.map((session) =>
      this.limit(async () => {
        // Skip if outline exists and hash matches
        if (
          session.outline &&
          session.outline_hash === session.transcript_hash
        ) {
          result.skipped++;
          this.progress.completed++;
          return;
        }

        try {
          this.progress.currentSession = session.id;

          // Skip API call for sessions with no assistant output
          const outline =
            session.output_tokens === '0'
              ? null
              : await this.generateOutline(session);

          await this.sql`
            UPDATE sessions.sessions
            SET outline = ${outline},
                outline_hash = ${session.transcript_hash}
            WHERE id = ${session.id}::uuid
          `;

          result.outlinesGenerated++;
          this.progress.completed++;
        } catch (error) {
          const message = `Failed to generate outline for ${session.id}: ${error}`;
          result.errors.push(message);
          this.progress.errors++;
          this.log.error({ error, sessionId: session.id }, message);
        }
      })
    );

    await Promise.all(promises);
    this.progress.currentSession = null;
    this.progress.isRunning = false;

    return result;
  }
}
