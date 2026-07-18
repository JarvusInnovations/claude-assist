/**
 * Tana inbox executor: files stray thoughts into the Tana capture inbox
 * via the tana-local MCP server (e.g. http://127.0.0.1:8262/mcp).
 *
 * The workspace's inbox node has the deterministic id
 * `{workspaceId}_CAPTURE_INBOX`; writes use the `import_tana_paste` tool
 * with minimal Tana Paste formatting (parent node = capture text, children
 * = extra lines/URLs + a provenance field).
 */

import type { CaptureRecord } from '../../types.js';
import type { RoutingExecutor } from '../router.js';
import type { TanaMcpClient } from '../tana-mcp.js';

/**
 * Format a capture as Tana Paste. Kept deliberately plain: no supertags
 * (applying unknown tags could mutate Tana schema), first text line becomes
 * the node, remaining lines and URLs become children, plus one provenance
 * field for traceability back to the capture row.
 */
export function formatTanaPaste(capture: CaptureRecord): string {
  const [first = '', ...rest] = capture.text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const children: string[] = rest.map((line) => `  - ${line}`);

  for (const url of capture.urls) {
    if (!capture.text.includes(url)) {
      children.push(`  - ${url}`);
    }
  }

  if (capture.tags.length > 0) {
    children.push(`  - tags:: ${capture.tags.join(', ')}`);
  }
  children.push(`  - captured:: ${capture.captured_at.toISOString()} via ${capture.source} (${capture.ulid})`);

  return [`- ${first}`, ...children].join('\n');
}

export class TanaInboxExecutor implements RoutingExecutor {
  readonly destination = 'tana-inbox';
  readonly kind = 'write' as const;

  constructor(
    private client: TanaMcpClient,
    private workspaceId: string
  ) {}

  async execute(capture: CaptureRecord): Promise<Record<string, unknown>> {
    const parentNodeId = `${this.workspaceId}_CAPTURE_INBOX`;
    const response = await this.client.callTool('import_tana_paste', {
      parentNodeId,
      content: formatTanaPaste(capture),
    });
    return {
      inbox: parentNodeId,
      response: response.slice(0, 500),
    };
  }
}
