import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Files above this size are listed but never downloaded (specs/modules/chat.md § Attachments). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** The subset of a Slack file object the module uses. */
export interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

export type Attachment =
  | { ok: true; name: string; mimetype: string; size: number; path: string }
  | { ok: false; name: string; mimetype: string; reason: string };

/**
 * Message subtypes that are a new turn from the owner: a plain message, or a
 * message with files attached. Edits, deletions and system events are not.
 */
export function isHandledSubtype(subtype: string | undefined): boolean {
  return subtype === undefined || subtype === 'file_share';
}

/** Folder name for one Slack thread's downloads — filesystem-safe. */
export function threadDirName(channel: string, threadTs: string): string {
  return `${channel}-${threadTs}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The agent's prompt: the message text, then an attachments section that
 * names every file — downloaded ones by path, failed ones with the reason —
 * so the agent never answers as though the message were text only.
 */
export function buildPrompt(text: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return text;

  const lines = ['[Attachments on this Slack message]'];
  for (const a of attachments) {
    if (a.ok) {
      lines.push(`- ${a.path} (${a.name}, ${a.mimetype}, ${formatSize(a.size)}) — open it with the Read tool`);
    } else {
      lines.push(`- ${a.name} (${a.mimetype}) — could not be downloaded: ${a.reason}`);
    }
  }
  const section = lines.join('\n');
  return text ? `${text}\n\n${section}` : section;
}

/**
 * Download each file into `dir` with the bot token. Never throws for a single
 * file: a failure becomes an `ok: false` entry carrying the reason.
 */
export async function downloadAttachments(
  files: SlackFile[],
  token: string,
  dir: string,
  fetchFn: typeof fetch = fetch,
): Promise<Attachment[]> {
  const results: Attachment[] = [];
  for (const file of files) {
    const name = file.name || file.id;
    const mimetype = file.mimetype || 'application/octet-stream';
    const url = file.url_private_download ?? file.url_private;

    if (!url) {
      results.push({ ok: false, name, mimetype, reason: 'Slack sent no download URL' });
      continue;
    }
    if ((file.size ?? 0) > MAX_ATTACHMENT_BYTES) {
      results.push({ ok: false, name, mimetype, reason: `larger than the ${formatSize(MAX_ATTACHMENT_BYTES)} limit` });
      continue;
    }

    try {
      const response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        results.push({ ok: false, name, mimetype, reason: `HTTP ${response.status} from Slack` });
        continue;
      }
      // Without files:read, Slack answers url_private with its HTML login page, not an error.
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.startsWith('text/html') && !mimetype.startsWith('text/html')) {
        results.push({ ok: false, name, mimetype, reason: 'Slack returned a login page — the bot token likely lacks the files:read scope' });
        continue;
      }

      const body = Buffer.from(await response.arrayBuffer());
      await mkdir(dir, { recursive: true });
      const safeName = basename(name).replace(/[^A-Za-z0-9._-]/g, '_') || file.id;
      const path = join(dir, `${file.id}-${safeName}`);
      await writeFile(path, body);
      results.push({ ok: true, name, mimetype, size: body.length, path });
    } catch (err) {
      results.push({ ok: false, name, mimetype, reason: `download failed: ${(err as Error).message}` });
    }
  }
  return results;
}
