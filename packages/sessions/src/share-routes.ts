import type { FastifyInstance } from 'fastify';
import { serializeTranscript } from './transcript.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type ItemType = 'user' | 'assistant' | 'tool' | 'question' | 'response' | 'skill' | 'notification';

interface TranscriptItem {
  type: ItemType;
  content: string;
}

const MARKER_MAP: Record<string, ItemType> = {
  '[U]': 'user',
  '[A]': 'assistant',
  '[T]': 'tool',
  '[?]': 'question',
  '[>]': 'response',
  '[S]': 'skill',
  '[N]': 'notification',
};

const ITEM_STYLE: Record<ItemType, { bg: string; text: string; border: string; label: string; icon: string }> = {
  user:         { bg: '#eff6ff', text: '#1d4ed8', border: '#60a5fa', label: 'User',         icon: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' },
  assistant:    { bg: '#ecfdf5', text: '#047857', border: '#34d399', label: 'Assistant',    icon: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>' },
  tool:         { bg: '#fffbeb', text: '#b45309', border: '#fbbf24', label: 'Tool Call',    icon: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>' },
  question:     { bg: '#faf5ff', text: '#7e22ce', border: '#c084fc', label: 'Question',     icon: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>' },
  response:     { bg: '#eef2ff', text: '#4338ca', border: '#818cf8', label: 'Response',     icon: '<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>' },
  skill:        { bg: '#fdf2f8', text: '#be185d', border: '#f472b6', label: 'Skill',        icon: '<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>' },
  notification: { bg: '#f9fafb', text: '#4b5563', border: '#9ca3af', label: 'Notification', icon: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>' },
};

function parseItems(transcript: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const markerRegex = /^(\[[UAT?>\]SN\]]) /gm;

  // Build a simpler regex matching the exact 7 markers
  const exactRegex = /^(\[U\]|\[A\]|\[T\]|\[\?\]|\[>\]|\[S\]|\[N\]) /gm;
  const markers: { index: number; marker: string }[] = [];

  let m;
  while ((m = exactRegex.exec(transcript)) !== null) {
    markers.push({ index: m.index, marker: m[1]! });
  }

  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i]!;
    const next = markers[i + 1];
    const contentStart = cur.index + cur.marker.length + 1;
    const contentEnd = next ? next.index : transcript.length;
    const content = transcript.slice(contentStart, contentEnd).trimEnd();
    const type = MARKER_MAP[cur.marker];
    if (type) items.push({ type, content });
  }

  return items;
}

function renderItems(items: TranscriptItem[]): string {
  return items.map(item => {
    const s = ITEM_STYLE[item.type];
    return `<div class="item" style="background:${s.bg};border-left:4px solid ${s.border};color:${s.text}">` +
      `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" title="${s.label}">${s.icon}</svg>` +
      `<p>${escapeHtml(item.content)}</p>` +
      `</div>`;
  }).join('\n');
}

function buildSharePage(opts: {
  authCode: string;
  sessionName: string | null;
  title: string | null;
  projectPath: string | null;
  startedAt: Date;
  transcript: string;
  baseUrl: string;
}): string {
  const { authCode, sessionName, title, projectPath, startedAt, transcript, baseUrl } = opts;
  const displayTitle = sessionName || title || projectPath?.split('/').pop() || 'Session Transcript';
  const projectDisplay = projectPath ?? '';
  const dateDisplay = startedAt.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const textUrl = `${baseUrl}/share/${authCode}/text`;
  const filename = `transcript-${authCode}.txt`;

  const items = parseItems(transcript);
  const renderedItems = renderItems(items);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(displayTitle)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; min-height: 100vh; }
    .header { background: #1e293b; border-bottom: 1px solid #334155; padding: 14px 24px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; position: sticky; top: 0; z-index: 10; }
    .header-info { flex: 1; min-width: 0; }
    .header-info h1 { font-size: 16px; font-weight: 600; color: #f1f5f9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .header-info .meta { font-size: 12px; color: #64748b; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .actions { display: flex; gap: 8px; flex-shrink: 0; }
    button { display: inline-flex; align-items: center; gap: 6px; padding: 6px 13px; border-radius: 6px; border: 1px solid #475569; background: #334155; color: #cbd5e1; font-size: 12px; font-weight: 500; cursor: pointer; transition: background 0.15s; }
    button:hover { background: #3d4f65; color: #f1f5f9; }
    button.copied { background: #14532d; border-color: #166534; color: #4ade80; }
    .transcript { padding: 20px 24px; max-width: 1100px; margin: 0 auto; display: flex; flex-direction: column; gap: 8px; }
    .item { display: flex; gap: 10px; padding: 10px 12px; border-radius: 6px; }
    .icon { width: 16px; height: 16px; flex-shrink: 0; margin-top: 2px; }
    .item p { flex: 1; min-width: 0; font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-info">
      <h1>${escapeHtml(displayTitle)}</h1>
      <div class="meta">${escapeHtml(projectDisplay)}${projectDisplay ? ' · ' : ''}${escapeHtml(dateDisplay)}</div>
    </div>
    <div class="actions">
      <button id="copyBtn" onclick="copyAgentLink()">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy Agent Link
      </button>
      <button onclick="downloadText()">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download Plain Text
      </button>
    </div>
  </div>
  <div class="transcript">
${renderedItems}
  </div>
  <script>
    const TEXT_URL = ${JSON.stringify(textUrl)};
    const FILENAME = ${JSON.stringify(filename)};
    const PLAIN_TEXT = ${JSON.stringify(transcript)};

    function copyAgentLink() {
      navigator.clipboard.writeText(TEXT_URL).then(() => {
        const btn = document.getElementById('copyBtn');
        const prev = btn.innerHTML;
        btn.classList.add('copied');
        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
        setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = prev; }, 2000);
      });
    }

    function downloadText() {
      const blob = new Blob([PLAIN_TEXT], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = FILENAME;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  </script>
</body>
</html>`;
}

export async function registerPublicShareRoutes(fastify: FastifyInstance) {
  // GET /share/:auth_code — rendered HTML transcript page (no auth required)
  fastify.get<{ Params: { auth_code: string } }>('/share/:auth_code', async (request, reply) => {
    const { auth_code } = request.params;

    const rows = await fastify.sql<{
      session_id: string;
      raw_transcript: string;
      title: string | null;
      session_name: string | null;
      project_path: string | null;
      started_at: Date;
    }[]>`
      SELECT s.id AS session_id, s.raw_transcript, s.title, s.session_name, s.project_path, s.started_at
      FROM sessions.shares sh
      JOIN sessions.sessions s ON s.id = sh.session_id
      WHERE sh.auth_code = ${auth_code}
    `;

    if (rows.length === 0) {
      reply.status(404).type('text/plain');
      return 'Share link not found';
    }

    const row = rows[0]!;
    const transcript = serializeTranscript(row.raw_transcript);

    const proto = (request.headers['x-forwarded-proto'] as string) ?? 'https';
    const host = (request.headers['x-forwarded-host'] as string) ?? request.headers.host ?? 'localhost';
    const baseUrl = `${proto}://${host}`;

    const html = buildSharePage({
      authCode: auth_code,
      sessionName: row.session_name,
      title: row.title,
      projectPath: row.project_path,
      startedAt: new Date(row.started_at),
      transcript,
      baseUrl,
    });

    reply.type('text/html');
    return html;
  });

  // GET /share/:auth_code/text — plain text transcript (no auth required, for agent consumption)
  fastify.get<{ Params: { auth_code: string } }>('/share/:auth_code/text', async (request, reply) => {
    const { auth_code } = request.params;

    const rows = await fastify.sql<{ raw_transcript: string }[]>`
      SELECT s.raw_transcript
      FROM sessions.shares sh
      JOIN sessions.sessions s ON s.id = sh.session_id
      WHERE sh.auth_code = ${auth_code}
    `;

    if (rows.length === 0) {
      reply.status(404).type('text/plain');
      return 'Share link not found';
    }

    const transcript = serializeTranscript(rows[0]!.raw_transcript);
    reply.type('text/plain');
    return transcript;
  });
}
