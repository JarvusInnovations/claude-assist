/**
 * Minimal MCP streamable-HTTP client for the tana-local server.
 *
 * Lives in core so any module (capture's inbox executor, the briefing's day-node
 * render) shares one verified client instead of maintaining a second copy.
 *
 * Protocol notes (verified against the running server on devbox:8262):
 * - Auth: `Authorization: Bearer <PAT>` (401 with OAuth metadata otherwise)
 * - Transport: single POST endpoint, JSON-RPC 2.0 bodies
 * - The server replies with `application/json` bodies and does NOT issue an
 *   `Mcp-Session-Id` header (stateless), but this client echoes one back if
 *   a server ever starts sending it, and parses `text/event-stream`
 *   responses too, per the streamable-HTTP spec
 * - tools/call results: { content: [{type:'text', text}], isError? }
 *
 * Only initialize / notifications/initialized / tools/call are implemented —
 * the surface the tana executors need.
 */

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface TanaMcpConfig {
  /** e.g. http://127.0.0.1:8262/mcp */
  url: string;
  /** Tana MCP Personal Access Token */
  token: string;
  timeoutMs?: number;
  /** clientInfo.name sent on initialize (default: claude-assist). */
  clientName?: string;
}

/**
 * Parse a streamable-HTTP MCP response body into JSON-RPC messages.
 * Handles both plain JSON and SSE framing. Exported for tests.
 */
export function parseMcpBody(contentType: string, body: string): JsonRpcResponse[] {
  if (contentType.includes('text/event-stream')) {
    const messages: JsonRpcResponse[] = [];
    for (const event of body.split(/\n\n/)) {
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data) continue;
      try {
        messages.push(JSON.parse(data) as JsonRpcResponse);
      } catch {
        // skip malformed frames (e.g. keepalives)
      }
    }
    return messages;
  }

  const trimmed = body.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcResponse[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export class TanaMcpClient {
  private url: string;
  private token: string;
  private timeoutMs: number;
  private clientName: string;
  private nextId = 1;
  private sessionId: string | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(config: TanaMcpConfig) {
    this.url = config.url;
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.clientName = config.clientName ?? 'claude-assist';
  }

  /**
   * Call an MCP tool and return its text content. Throws on transport,
   * JSON-RPC, or tool (`isError`) failures — callers own retries.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureInitialized();

    let response: JsonRpcResponse;
    try {
      response = await this.request('tools/call', { name, arguments: args });
    } catch (error) {
      // One re-init + retry: covers a restarted server invalidating
      // whatever session state it may keep.
      this.reset();
      await this.ensureInitialized();
      response = await this.request('tools/call', { name, arguments: args });
    }

    if (response.error) {
      throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
    }

    const result = response.result as ToolCallResult | undefined;
    const text = (result?.content ?? [])
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');

    if (result?.isError) {
      throw new Error(`Tool ${name} failed: ${text || 'unknown tool error'}`);
    }
    return text;
  }

  private reset(): void {
    this.initPromise = null;
    this.sessionId = null;
  }

  private ensureInitialized(): Promise<void> {
    this.initPromise ??= this.initialize().catch((error) => {
      this.reset();
      throw error;
    });
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    const response = await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: this.clientName, version: '0.1.0' },
    });
    if (response.error) {
      throw new Error(`MCP initialize failed: ${response.error.message}`);
    }
    // Fire-and-forget per spec; the server may answer 202 with no body
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
  }

  private async request(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const { response, messages } = await this.post({ jsonrpc: '2.0', id, method, params });

    const match = messages.find((message) => message.id === id);
    if (!match) {
      throw new Error(
        `MCP ${method}: no response with id ${id} (HTTP ${response.status}, ${messages.length} messages)`
      );
    }
    return match;
  }

  private async post(
    body: Record<string, unknown>
  ): Promise<{ response: Response; messages: JsonRpcResponse[] }> {
    const response = await fetch(this.url, {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      },
      body: JSON.stringify(body),
    });

    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    const contentType = response.headers.get('content-type') ?? 'application/json';
    return { response, messages: parseMcpBody(contentType, text) };
  }
}
