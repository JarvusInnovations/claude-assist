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
import type { AttachmentStorage } from '../attachments/storage.js';

/** A resolved attachment link (filename + signed read URL) for rendering. */
export interface AttachmentLink {
  filename: string;
  url: string;
}

/**
 * Format a capture as Tana Paste. Kept deliberately plain: no supertags
 * (applying unknown tags could mutate Tana schema), first text line becomes
 * the node, remaining lines and URLs become children, plus one provenance
 * field for traceability back to the capture row.
 *
 * When `attachmentLinks` are supplied (signed read URLs resolved by the
 * executor), each is appended as a markdown-link child so the node points
 * back at the stored file/photo.
 */
export function formatTanaPaste(
  capture: CaptureRecord,
  attachmentLinks: AttachmentLink[] = []
): string {
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

  for (const link of attachmentLinks) {
    children.push(`  - attachment:: [${link.filename}](${link.url})`);
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
    private workspaceId: string,
    /** Optional object store; when present, attachment read links are appended. */
    private storage: AttachmentStorage | null = null
  ) {}

  async execute(capture: CaptureRecord): Promise<Record<string, unknown>> {
    const parentNodeId = `${this.workspaceId}_CAPTURE_INBOX`;

    // Resolve signed read URLs for any attachments so the node links back to
    // the stored bytes. Nothing is public — each URL is short-lived.
    let attachmentLinks: AttachmentLink[] = [];
    if (this.storage && capture.attachments.length > 0) {
      attachmentLinks = await Promise.all(
        capture.attachments.map(async (a) => ({
          filename: a.filename,
          url: await this.storage!.signRead(a.object_key),
        }))
      );
    }

    const response = await this.client.callTool('import_tana_paste', {
      parentNodeId,
      content: formatTanaPaste(capture, attachmentLinks),
    });
    return {
      inbox: parentNodeId,
      response: response.slice(0, 500),
      attachment_count: attachmentLinks.length,
    };
  }
}
