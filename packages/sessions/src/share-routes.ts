import type { FastifyInstance } from 'fastify';
import { serializeTranscript } from './transcript.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSharePage(opts: {
  sessionId: string;
  authCode: string;
  title: string | null;
  projectPath: string | null;
  startedAt: Date;
  transcript: string;
  baseUrl: string;
}): string {
  const { authCode, title, projectPath, startedAt, transcript, baseUrl } = opts;
  const displayTitle = title || projectPath?.split('/').pop() || 'Session Transcript';
  const projectDisplay = projectPath ?? '';
  const dateDisplay = startedAt.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const textUrl = `${baseUrl}/share/${authCode}/text`;
  const htmlUrl = `${baseUrl}/share/${authCode}`;
  const filename = `transcript-${authCode}.txt`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(displayTitle)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; }
    .header { background: #1a1d27; border-bottom: 1px solid #2d3148; padding: 16px 24px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
    .header-info { flex: 1; min-width: 0; }
    .header-info h1 { font-size: 18px; font-weight: 600; color: #f1f5f9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .header-info .meta { font-size: 13px; color: #64748b; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .actions { display: flex; gap: 8px; flex-shrink: 0; }
    button { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 6px; border: 1px solid #3d4263; background: #252840; color: #c4cce0; font-size: 13px; font-weight: 500; cursor: pointer; transition: background 0.15s, color 0.15s; }
    button:hover { background: #2f3455; color: #f1f5f9; }
    button.success { background: #1a3a2a; border-color: #2a5c40; color: #4ade80; }
    .transcript-wrap { padding: 24px; max-width: 1200px; margin: 0 auto; }
    pre { background: #141620; border: 1px solid #252840; border-radius: 8px; padding: 20px 24px; font-family: 'SFMono-Regular', 'Cascadia Code', 'Fira Mono', Consolas, monospace; font-size: 13px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; color: #c4cce0; overflow-x: auto; }
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
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy Agent Link
      </button>
      <button onclick="downloadText()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download Plain Text
      </button>
    </div>
  </div>
  <div class="transcript-wrap">
    <pre id="transcriptText">${escapeHtml(transcript)}</pre>
  </div>
  <script>
    const TEXT_URL = ${JSON.stringify(textUrl)};
    const HTML_URL = ${JSON.stringify(htmlUrl)};
    const FILENAME = ${JSON.stringify(filename)};

    function copyAgentLink() {
      navigator.clipboard.writeText(TEXT_URL).then(() => {
        const btn = document.getElementById('copyBtn');
        const prev = btn.innerHTML;
        btn.classList.add('success');
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
        setTimeout(() => { btn.classList.remove('success'); btn.innerHTML = prev; }, 2000);
      });
    }

    function downloadText() {
      const text = document.getElementById('transcriptText').textContent;
      const blob = new Blob([text], { type: 'text/plain' });
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
      project_path: string | null;
      started_at: Date;
    }[]>`
      SELECT s.id AS session_id, s.raw_transcript, s.title, s.project_path, s.started_at
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
    const host = request.headers['x-forwarded-host'] as string ?? request.headers.host ?? 'localhost';
    const baseUrl = `${proto}://${host}`;

    const html = buildSharePage({
      sessionId: row.session_id,
      authCode: auth_code,
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
