import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import type { SyncService } from './sync.js';
import { OutlineService } from './outline.js';
import type {
  PushPayload,
  SessionRecord,
  MachineRecord,
  InventoryPayload,
} from './types.js';
import { serializeTranscript, findInTranscript, readAround, type MatchDimension } from './transcript.js';
import { normalizeProjectPaths } from './project-names.js';
import type { ClassificationService } from './classification/service.js';
import type { SynthesisService } from './classification/synthesis.js';
import { lastWeekPeriod, type Period } from './classification/synthesis.js';
import type { ClassificationStore } from './classification/store.js';

/**
 * Parse model_tokens JSONB field, ensuring all nested values are integers.
 * postgres.js may return JSONB as a string, and BIGINT values as strings.
 */
function parseModelTokens(
  value: unknown
): Record<string, { input: number; output: number; cacheRead: number }> {
  if (!value) return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  const result: Record<string, { input: number; output: number; cacheRead: number }> = {};
  for (const [model, tokens] of Object.entries(parsed)) {
    const t = tokens as { input?: unknown; output?: unknown; cacheRead?: unknown };
    result[model] = {
      input: parseInt(String(t.input ?? 0), 10) || 0,
      output: parseInt(String(t.output ?? 0), 10) || 0,
      cacheRead: parseInt(String(t.cacheRead ?? 0), 10) || 0,
    };
  }
  return result;
}

/** Shape a windowing result for JSON responses (snake_case, paging anchors). */
function serializeWindow(w: import('./transcript.js').MessageWindow) {
  return {
    lines: w.lines,
    anchor: w.anchor,
    head: w.head,
    tail: w.tail,
    more_before: w.moreBefore,
    more_after: w.moreAfter,
    truncated: w.truncated,
  };
}

function serializeMatch(m: import('./transcript.js').TranscriptMatch) {
  return { anchor: m.anchor, index: m.index, ts: m.ts, tool: m.tool, target: m.target, window: serializeWindow(m.window) };
}

export interface RoutesConfig {
  syncService: SyncService;
  outlineService: OutlineService | null;
  classificationService?: ClassificationService | null;
  synthesisService?: SynthesisService | null;
  classificationStore?: ClassificationStore | null;
}

/**
 * Register session API routes
 */
export const registerRoutes: FastifyPluginAsync<RoutesConfig> = async (
  fastify,
  { syncService, outlineService, classificationService, synthesisService, classificationStore }
) => {
  // GET /sessions - Search sessions with full-text search and filters
  fastify.get<{
    Querystring: {
      search?: string;
      days?: string;
      since?: string;
      until?: string;
      forever?: string;
      tools?: string;
      files_read?: string;
      files_written?: string;
      machine?: string;
      project?: string;
      limit?: string;
      offset?: string;
      include_empty?: string;
      min_user_messages?: string;

    };
  }>('/sessions', async (request, reply) => {
    const {
      search,
      days = '30',
      since,
      until,
      forever,
      tools,
      files_read,
      files_written,
      machine,
      project,
      limit = '20',
      offset = '0',
      include_empty,
      min_user_messages,
    } = request.query;
    const excludeEmpty = include_empty !== 'true';
    const minUserMsgs = min_user_messages ? parseInt(min_user_messages, 10) : null;

    const daysNum = parseInt(days, 10) || 30;
    const limitNum = Math.max(parseInt(limit, 10) || 20, 1);
    const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

    // Parse absolute date filters (ISO 8601)
    const sinceDate = since ? new Date(since) : null;
    const untilDate = until ? new Date(until) : null;

    // Validate date formats
    if (sinceDate && isNaN(sinceDate.getTime())) {
      return reply.status(400).send({ error: 'Invalid since date format' });
    }
    if (untilDate && isNaN(untilDate.getTime())) {
      return reply.status(400).send({ error: 'Invalid until date format' });
    }

    const useDateRange = sinceDate || untilDate;
    const foreverMode = forever === 'true';

    // Build dynamic query based on filters
    let sessions;

    if (search) {
      // Full-text search + session_name substring (ILIKE) fallback for
      // identifier-style names that don't tokenize well (e.g. "fine" → "refinement")
      const escapedSearch = search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      const namePattern = '%' + escapedSearch + '%';
      sessions = await fastify.sql`
        SELECT
          s.id,
          s.started_at,
          s.ended_at,
          s.project_path,
          s.git_branch,
          s.tools_used,
          s.files_touched,
          s.message_count,
          s.user_message_count,
          s.input_tokens,
          s.output_tokens,
          s.outline,
          s.title,
          s.session_name,
          m.machine_id,
          ts_rank(s.search_vector, websearch_to_tsquery('english', ${search})) as rank
        FROM sessions.sessions s
        JOIN sessions.machines m ON s.machine_id = m.id
        WHERE (
          s.search_vector @@ websearch_to_tsquery('english', ${search})
          OR s.session_name ILIKE ${namePattern}
          OR s.project_path ILIKE ${namePattern}
        )
          ${foreverMode
            ? fastify.sql``
            : useDateRange
              ? fastify.sql`
                ${sinceDate ? fastify.sql`AND s.started_at >= ${sinceDate}` : fastify.sql``}
                ${untilDate ? fastify.sql`AND s.started_at <= ${untilDate}` : fastify.sql``}
              `
              : fastify.sql`AND s.started_at > NOW() - INTERVAL '1 day' * ${daysNum}`
          }
          ${excludeEmpty ? fastify.sql`AND s.output_tokens > 0` : fastify.sql``}
          ${minUserMsgs !== null ? fastify.sql`AND s.user_message_count >= ${minUserMsgs}` : fastify.sql``}
          ${machine ? fastify.sql`AND m.machine_id = ${machine}` : fastify.sql``}
          ${project ? fastify.sql`AND s.project_path ILIKE ${'%' + project + '%'}` : fastify.sql``}
          ${tools ? fastify.sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.tools_used) AS t WHERE t ILIKE ANY(${tools.split(',').map(t => '%' + t.trim() + '%')}))` : fastify.sql``}
          ${files_read ? fastify.sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.files_touched->'reads') AS f WHERE f ILIKE ANY(${files_read.split(',').map(f => '%' + f.trim() + '%')}))` : fastify.sql``}
          ${files_written ? fastify.sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.files_touched->'writes') AS f WHERE f ILIKE ANY(${files_written.split(',').map(f => '%' + f.trim() + '%')}))` : fastify.sql``}
        ORDER BY rank DESC, s.started_at DESC
        LIMIT ${limitNum} OFFSET ${offsetNum}
      `;
    } else {
      // No search, just filters
      sessions = await fastify.sql`
        SELECT
          s.id,
          s.started_at,
          s.ended_at,
          s.project_path,
          s.git_branch,
          s.tools_used,
          s.files_touched,
          s.message_count,
          s.user_message_count,
          s.input_tokens,
          s.output_tokens,
          s.outline,
          s.title,
          s.session_name,
          m.machine_id
        FROM sessions.sessions s
        JOIN sessions.machines m ON s.machine_id = m.id
        WHERE 1=1
          ${foreverMode
            ? fastify.sql``
            : useDateRange
              ? fastify.sql`
                ${sinceDate ? fastify.sql`AND s.started_at >= ${sinceDate}` : fastify.sql``}
                ${untilDate ? fastify.sql`AND s.started_at <= ${untilDate}` : fastify.sql``}
              `
              : fastify.sql`AND s.started_at > NOW() - INTERVAL '1 day' * ${daysNum}`
          }
          ${excludeEmpty ? fastify.sql`AND s.output_tokens > 0` : fastify.sql``}
          ${minUserMsgs !== null ? fastify.sql`AND s.user_message_count >= ${minUserMsgs}` : fastify.sql``}
          ${machine ? fastify.sql`AND m.machine_id = ${machine}` : fastify.sql``}
          ${project ? fastify.sql`AND s.project_path ILIKE ${'%' + project + '%'}` : fastify.sql``}
          ${tools ? fastify.sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.tools_used) AS t WHERE t ILIKE ANY(${tools.split(',').map(t => '%' + t.trim() + '%')}))` : fastify.sql``}
          ${files_read ? fastify.sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.files_touched->'reads') AS f WHERE f ILIKE ANY(${files_read.split(',').map(f => '%' + f.trim() + '%')}))` : fastify.sql``}
          ${files_written ? fastify.sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.files_touched->'writes') AS f WHERE f ILIKE ANY(${files_written.split(',').map(f => '%' + f.trim() + '%')}))` : fastify.sql``}
        ORDER BY s.started_at DESC
        LIMIT ${limitNum} OFFSET ${offsetNum}
      `;
    }

    return sessions.map((s) => ({
      id: s.id,
      started_at: s.started_at,
      ended_at: s.ended_at,
      project_path: s.project_path,
      git_branch: s.git_branch,
      outline: s.outline ?? null,
      title: s.title ?? null,
      session_name: s.session_name ?? null,
      message_count: s.message_count,
      user_message_count: s.user_message_count,
      input_tokens: parseInt(String(s.input_tokens), 10) || 0,
      output_tokens: parseInt(String(s.output_tokens), 10) || 0,
      tools_used: s.tools_used,
      files_touched: s.files_touched,
      machine: s.machine_id,
    }));
  });

  // GET /sessions/activity - Activity ranges for timeline visualization
  fastify.get<{
    Querystring: { days?: string };
  }>('/sessions/activity', async (request) => {
    const days = parseInt(request.query.days ?? '7', 10) || 7;

    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();

    const sessions = await fastify.sql`
      SELECT id, title, session_name, project_path, activity_ranges, outline
      FROM sessions.sessions
      WHERE jsonb_array_length(activity_ranges) > 0
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(activity_ranges) r
          WHERE r->>'end' >= ${cutoff}
        )
      ORDER BY started_at
    `;

    const projectPaths = sessions
      .map((s) => s.project_path)
      .filter((p): p is string => p != null);
    const projectNames = normalizeProjectPaths(projectPaths);

    return sessions.map((s) => {
      const ranges: Array<{ start: string; end: string }> =
        typeof s.activity_ranges === 'string'
          ? JSON.parse(s.activity_ranges)
          : s.activity_ranges ?? [];

      const enrichedRanges = ranges.map((r) => {
        const ms = new Date(r.end).getTime() - new Date(r.start).getTime();
        return { ...r, duration_minutes: Math.round(ms / 60_000) };
      });

      const totalMinutes = enrichedRanges.reduce((sum, r) => sum + r.duration_minutes, 0);

      return {
        id: s.id,
        title: s.title ?? null,
        session_name: s.session_name ?? null,
        project_path: s.project_path,
        project_name: s.project_path ? (projectNames.get(s.project_path) ?? null) : null,
        activity_ranges: enrichedRanges,
        total_active_minutes: totalMinutes,
        outline: s.outline ?? null,
      };
    });
  });

  // GET /sessions/transcript - Cross-session transcript for a time range
  // Returns LLM-optimized text/plain, grouped by project or sequenced by time
  // Must be registered before /sessions/:id to avoid :id capturing "transcript"
  fastify.get<{
    Querystring: {
      before: string;
      after: string;
      group?: string;
      project?: string;
      min_user_messages?: string;
      include_tools?: string;
    };
  }>('/sessions/transcript', async (request, reply) => {
    const { before, after, group = 'project', project, min_user_messages = '2', include_tools = 'false' } = request.query;
    const includeTools = include_tools === 'true' || include_tools === '1';

    if (!before || !after) {
      return reply.status(400).send({ error: 'Both before and after params are required' });
    }

    const beforeDate = new Date(before);
    const afterDate = new Date(after);
    if (isNaN(beforeDate.getTime())) {
      return reply.status(400).send({ error: 'Invalid before date format' });
    }
    if (isNaN(afterDate.getTime())) {
      return reply.status(400).send({ error: 'Invalid after date format' });
    }
    if (group !== 'project' && group !== 'time') {
      return reply.status(400).send({ error: 'group must be "project" or "time"' });
    }
    const minMessages = parseInt(min_user_messages, 10);
    if (isNaN(minMessages) || minMessages < 0) {
      return reply.status(400).send({ error: 'min_user_messages must be a non-negative integer' });
    }

    // Overlap query: selects sessions that span any part of [after, before].
    // Per-message timestamp filtering in serializeTranscript() trims to the exact window.
    const escapedProject = project?.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const sessions = await fastify.sql<
      { id: string; project_path: string | null; raw_transcript: string; started_at: Date }[]
    >`
      SELECT id, project_path, raw_transcript, started_at
      FROM sessions.sessions
      WHERE started_at <= ${beforeDate}
        AND (ended_at >= ${afterDate} OR ended_at IS NULL)
        AND output_tokens > 0
        AND user_message_count >= ${minMessages}
        ${escapedProject ? fastify.sql`AND project_path ILIKE ${'%' + escapedProject + '%'}` : fastify.sql``}
      ORDER BY started_at ASC
      LIMIT 50
    `;

    // Clamp session header timestamp to the query window so long-running sessions
    // don't misleadingly show dates outside the requested range
    const displayTime = (s: { started_at: Date }) =>
      s.started_at < afterDate ? afterDate.toISOString() : s.started_at.toISOString();

    if (group === 'time') {
      const parts: string[] = [];
      for (const s of sessions) {
        const transcript = serializeTranscript(s.raw_transcript, {
          after: afterDate,
          before: beforeDate,
          includeTools,
        });
        if (!transcript.trim()) continue;
        const proj = s.project_path ?? 'unknown';
        parts.push(`--- [${proj}] ${displayTime(s)} ---\n${transcript}`);
      }
      reply.type('text/plain');
      return parts.join('\n\n');
    }

    // group=project (default)
    type SessionRow = { id: string; project_path: string | null; raw_transcript: string; started_at: Date };
    const byProject = new Map<string, SessionRow[]>();
    for (const s of sessions) {
      const key = s.project_path ?? 'unknown';
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(s);
    }

    const parts: string[] = [];
    for (const [proj, projectSessions] of byProject) {
      const sectionParts = [`=== ${proj} ===`];
      for (const s of projectSessions) {
        const transcript = serializeTranscript(s.raw_transcript, {
          after: afterDate,
          before: beforeDate,
          includeTools,
        });
        if (!transcript.trim()) continue;
        sectionParts.push(`--- ${displayTime(s)} ---\n${transcript}`);
      }
      if (sectionParts.length > 1) parts.push(sectionParts.join('\n\n'));
    }

    reply.type('text/plain');
    return parts.join('\n\n');
  });

  // GET /sessions/find - Cross-session tool-call discovery over the index (#48)
  // Registered before /sessions/:id so ":id" doesn't capture "find".
  fastify.get<{
    Querystring: {
      tool?: string;
      match?: string;
      in?: string;
      project?: string;
      days?: string;
      limit?: string;
      include_sidechain?: string;
    };
  }>('/sessions/find', async (request, reply) => {
    const { tool, match, in: dim = 'any', project, days, limit = '20', include_sidechain } = request.query;
    if (!tool && !match) {
      return reply.status(400).send({ error: 'Provide a tool and/or match filter' });
    }
    if (match && dim === 'text') {
      return reply.status(400).send({
        error: 'Cross-session text search is not indexed — use the search endpoint to find sessions, then find within one with in=text',
      });
    }
    const limitNum = Math.min(parseInt(limit, 10) || 20, 200);
    const daysNum = days ? parseInt(days, 10) : null;
    const includeSide = include_sidechain === 'true';

    const rows = await fastify.sql`
      SELECT tc.session_id, tc.msg_uuid, tc.msg_index, tc.ts, tc.tool_name, tc.target,
             s.project_path, s.title, s.session_name, m.machine_id
      FROM sessions.tool_calls tc
      JOIN sessions.sessions s ON tc.session_id = s.id
      JOIN sessions.machines m ON s.machine_id = m.id
      WHERE 1=1
        ${tool ? fastify.sql`AND tc.tool_name ILIKE ${'%' + tool + '%'}` : fastify.sql``}
        ${match
          ? dim === 'tool'
            ? fastify.sql`AND tc.tool_name ILIKE ${'%' + match + '%'}`
            : dim === 'target'
              ? fastify.sql`AND tc.target ILIKE ${'%' + match + '%'}`
              : fastify.sql`AND (tc.target ILIKE ${'%' + match + '%'} OR tc.tool_name ILIKE ${'%' + match + '%'})`
          : fastify.sql``}
        ${project ? fastify.sql`AND s.project_path ILIKE ${'%' + project + '%'}` : fastify.sql``}
        ${daysNum ? fastify.sql`AND tc.ts > NOW() - INTERVAL '1 day' * ${daysNum}` : fastify.sql``}
        ${includeSide ? fastify.sql`` : fastify.sql`AND tc.is_sidechain = FALSE`}
      ORDER BY tc.ts DESC NULLS LAST
      LIMIT ${limitNum}
    `;

    return rows.map((r) => ({
      session_id: r.session_id,
      anchor: r.msg_uuid,
      index: r.msg_index,
      ts: r.ts,
      tool: r.tool_name,
      target: r.target,
      project_path: r.project_path,
      title: r.title ?? r.session_name ?? null,
      machine: r.machine_id,
    }));
  });

  // GET /sessions/:id - Get session details
  fastify.get<{
    Params: { id: string };
    Querystring: { with_raw_messages?: string };
  }>('/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      return reply.status(400).send({ error: 'Invalid session id' });
    }
    const withRawMessages = request.query.with_raw_messages === 'true';

    const sessions = await fastify.sql<(SessionRecord & { machine_name: string })[]>`
      SELECT s.*, m.machine_id as machine_name
      FROM sessions.sessions s
      JOIN sessions.machines m ON s.machine_id = m.id
      WHERE s.id = ${id}::uuid
    `;

    if (sessions.length === 0) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    const session = sessions[0]!;

    const result: Record<string, unknown> = {
      id: session.id,
      machine: session.machine_name,
      project_path: session.project_path,
      git_branch: session.git_branch,
      started_at: session.started_at,
      ended_at: session.ended_at,
      user_messages: session.user_messages,
      tools_used: session.tools_used,
      files_touched: session.files_touched,
      message_count: session.message_count,
      user_message_count: session.user_message_count,
      input_tokens: parseInt(String(session.input_tokens), 10) || 0,
      output_tokens: parseInt(String(session.output_tokens), 10) || 0,
      cache_read_tokens: parseInt(String(session.cache_read_tokens), 10) || 0,
      claude_version: session.claude_version,
      outline: session.outline,
      title: session.title,
      session_name: session.session_name ?? null,
      outline_hash: session.outline_hash,
      models_used: session.models_used,
      model_tokens: parseModelTokens(session.model_tokens),
    };

    if (withRawMessages) {
      // Parse the raw_transcript JSONL into messages
      const messages = session.raw_transcript
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      result.raw_messages = messages;
    }

    return result;
  });

  // GET /sessions/:id/transcript - Get session transcript in compact format
  // Returns token-efficient text format (same as used for outline generation)
  // Optional before/after query params to trim messages to a time range
  fastify.get<{
    Params: { id: string };
    Querystring: { before?: string; after?: string; include_tools?: string; around?: string };
  }>('/sessions/:id/transcript', async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      return reply.status(400).send({ error: 'Invalid session id' });
    }
    const { before, after, include_tools = 'false', around } = request.query;
    const includeTools = include_tools === 'true' || include_tools === '1';

    // Anchor-exploration mode (#48): when `around` (a message uuid) is given,
    // `before`/`after` are message COUNTS, not dates. Returns a windowed JSON
    // payload with head/tail anchors and how much transcript remains each way.
    if (around) {
      const beforeN = before !== undefined ? parseInt(before, 10) : 1;
      const afterN = after !== undefined ? parseInt(after, 10) : 1;
      if (Number.isNaN(beforeN) || Number.isNaN(afterN) || beforeN < 0 || afterN < 0) {
        return reply.status(400).send({ error: 'before/after must be non-negative integers in around mode' });
      }
      const rows = await fastify.sql<{ raw_transcript: string }[]>`
        SELECT raw_transcript FROM sessions.sessions WHERE id = ${id}::uuid
      `;
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Session not found' });
      }
      const window = readAround(rows[0]!.raw_transcript, around, beforeN, afterN);
      if (!window) {
        return reply.status(404).send({ error: 'Anchor uuid not found in this session' });
      }
      return serializeWindow(window);
    }

    const beforeDate = before ? new Date(before) : undefined;
    const afterDate = after ? new Date(after) : undefined;
    if (beforeDate && isNaN(beforeDate.getTime())) {
      return reply.status(400).send({ error: 'Invalid before date format' });
    }
    if (afterDate && isNaN(afterDate.getTime())) {
      return reply.status(400).send({ error: 'Invalid after date format' });
    }

    const sessions = await fastify.sql<{ raw_transcript: string }[]>`
      SELECT raw_transcript
      FROM sessions.sessions
      WHERE id = ${id}::uuid
    `;

    if (sessions.length === 0) {
      reply.status(404);
      return { error: 'Session not found' };
    }

    const session = sessions[0]!;
    const transcript = serializeTranscript(session.raw_transcript, {
      before: beforeDate,
      after: afterDate,
      includeTools,
    });

    reply.type('text/plain');
    return transcript;
  });

  // GET /sessions/:id/find - Search within one transcript, windowed matches (#48)
  fastify.get<{
    Params: { id: string };
    Querystring: {
      tool?: string;
      match?: string;
      in?: string;
      context?: string;
      after_uuid?: string;
      before_uuid?: string;
      limit?: string;
      include_sidechain?: string;
    };
  }>('/sessions/:id/find', async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      return reply.status(400).send({ error: 'Invalid session id' });
    }
    const q = request.query;
    if (!q.tool && !q.match) {
      return reply.status(400).send({ error: 'Provide a tool and/or match filter' });
    }

    const rows = await fastify.sql<{ raw_transcript: string }[]>`
      SELECT raw_transcript FROM sessions.sessions WHERE id = ${id}::uuid
    `;
    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const matches = findInTranscript(rows[0]!.raw_transcript, {
      tool: q.tool,
      match: q.match,
      in: (q.in as MatchDimension) ?? 'any',
      context: q.context ? parseInt(q.context, 10) : 1,
      afterUuid: q.after_uuid,
      beforeUuid: q.before_uuid,
      limit: q.limit ? parseInt(q.limit, 10) : 10,
      includeSidechain: q.include_sidechain === 'true',
    });

    return { count: matches.length, matches: matches.map(serializeMatch) };
  });

  // POST /sessions/:id/share — generate a shareable auth code for a session transcript
  fastify.post<{ Params: { id: string } }>('/sessions/:id/share', async (request, reply) => {
    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      return reply.status(400).send({ error: 'Invalid session id' });
    }

    const sessions = await fastify.sql`
      SELECT id FROM sessions.sessions WHERE id = ${id}::uuid
    `;
    if (sessions.length === 0) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const authCode = randomBytes(15).toString('base64url');
    await fastify.sql`
      INSERT INTO sessions.shares (session_id, auth_code)
      VALUES (${id}::uuid, ${authCode})
    `;
    return { auth_code: authCode };
  });

  // GET /sessions/stats - Session statistics
  fastify.get<{
    Querystring: { days?: string; machine?: string };
  }>('/sessions/stats', async (request) => {
    const { days = '30', machine } = request.query;
    const daysNum = parseInt(days, 10) || 30;

    // Basic stats
    const stats = await fastify.sql`
      SELECT
        COUNT(*)::int as total_sessions,
        COUNT(DISTINCT DATE(s.started_at))::int as active_days,
        COALESCE(AVG(s.message_count), 0)::int as avg_messages,
        COALESCE(SUM(s.message_count), 0)::int as total_messages,
        COALESCE(SUM(s.input_tokens), 0)::bigint as total_input_tokens,
        COALESCE(SUM(s.output_tokens), 0)::bigint as total_output_tokens,
        COUNT(DISTINCT s.project_path)::int as unique_projects
      FROM sessions.sessions s
      JOIN sessions.machines m ON s.machine_id = m.id
      WHERE s.started_at > NOW() - INTERVAL '1 day' * ${daysNum}
        ${machine ? fastify.sql`AND m.machine_id = ${machine}` : fastify.sql``}
    `;

    // Top tools (only from sessions with valid tools_used arrays)
    const topTools = await fastify.sql`
      SELECT tool, COUNT(*)::int as count
      FROM sessions.sessions s
      JOIN sessions.machines m ON s.machine_id = m.id,
      LATERAL jsonb_array_elements_text(s.tools_used) as tool
      WHERE s.started_at > NOW() - INTERVAL '1 day' * ${daysNum}
        AND s.tools_used IS NOT NULL
        AND jsonb_typeof(s.tools_used) = 'array'
        AND jsonb_array_length(s.tools_used) > 0
        ${machine ? fastify.sql`AND m.machine_id = ${machine}` : fastify.sql``}
      GROUP BY tool
      ORDER BY count DESC
      LIMIT 10
    `;

    // Sessions per machine
    const perMachine = await fastify.sql`
      SELECT m.machine_id, COUNT(*)::int as session_count
      FROM sessions.sessions s
      JOIN sessions.machines m ON s.machine_id = m.id
      WHERE s.started_at > NOW() - INTERVAL '1 day' * ${daysNum}
      GROUP BY m.machine_id
      ORDER BY session_count DESC
    `;

    // Top models (only from sessions with valid models_used arrays)
    const topModels = await fastify.sql`
      SELECT model, COUNT(*)::int as session_count,
        COALESCE(SUM((s.model_tokens->model->>'input')::bigint), 0)::bigint as input_tokens,
        COALESCE(SUM((s.model_tokens->model->>'output')::bigint), 0)::bigint as output_tokens,
        COALESCE(SUM((s.model_tokens->model->>'cacheRead')::bigint), 0)::bigint as cache_read_tokens
      FROM sessions.sessions s
      JOIN sessions.machines m ON s.machine_id = m.id,
      LATERAL jsonb_array_elements_text(s.models_used) as model
      WHERE s.started_at > NOW() - INTERVAL '1 day' * ${daysNum}
        AND s.models_used IS NOT NULL
        AND jsonb_typeof(s.models_used) = 'array'
        AND jsonb_array_length(s.models_used) > 0
        ${machine ? fastify.sql`AND m.machine_id = ${machine}` : fastify.sql``}
      GROUP BY model
      ORDER BY session_count DESC
      LIMIT 10
    `;

    const s = stats[0]!;
    return {
      period_days: daysNum,
      total_sessions: s.total_sessions,
      active_days: s.active_days,
      avg_messages: s.avg_messages,
      total_messages: s.total_messages,
      total_input_tokens: parseInt(String(s.total_input_tokens), 10) || 0,
      total_output_tokens: parseInt(String(s.total_output_tokens), 10) || 0,
      unique_projects: s.unique_projects,
      top_tools: topTools,
      top_models: topModels.map((m) => ({
        model: m.model,
        session_count: m.session_count,
        input_tokens: parseInt(String(m.input_tokens), 10) || 0,
        output_tokens: parseInt(String(m.output_tokens), 10) || 0,
        cache_read_tokens: parseInt(String(m.cache_read_tokens), 10) || 0,
      })),
      sessions_per_machine: perMachine,
    };
  });

  // POST /sessions/inventory - Phase 1: Check which sessions are needed (two-phase sync)
  fastify.post<{ Body: InventoryPayload }>(
    '/sessions/inventory',
    async (request, reply) => {
      const payload = request.body;

      if (!payload?.machineId) {
        reply.status(400);
        return { error: 'machineId is required' };
      }

      if (!payload.inventory || !Array.isArray(payload.inventory)) {
        reply.status(400);
        return { error: 'inventory array is required' };
      }

      const result = await syncService.processInventory(payload);
      return result;
    }
  );

  // POST /sessions/push - Receive sessions from satellite machines
  fastify.post<{ Body: PushPayload }>('/sessions/push', async (request, reply) => {
    const payload = request.body;

    if (!payload?.machineId) {
      reply.status(400);
      return { error: 'machineId is required' };
    }

    if (!payload.sessions || !Array.isArray(payload.sessions)) {
      reply.status(400);
      return { error: 'sessions array is required' };
    }

    const result = await syncService.processPush(payload);

    // Queue outline generation for newly pushed sessions
    if (outlineService && (result.sessionsIngested > 0 || result.sessionsUpdated > 0)) {
      outlineService.queueOutlineGeneration();
    }

    // Coverage heartbeat: this machine's session push succeeded (absence pages).
    await fastify.heartbeats?.beat(`session-ingest:${payload.machineId}`, {
      threshold: '48 hours',
      metadata: { machineId: payload.machineId },
    });

    return result;
  });

  // POST /sessions/sync - Manually trigger local sync
  // Use ?force=true to re-parse all sessions even if hash matches (for parser upgrades)
  fastify.post<{
    Querystring: { force?: string };
  }>('/sessions/sync', async (request) => {
    const forceReparse = request.query.force === 'true';
    const result = await syncService.syncLocal(forceReparse);

    // Queue outline generation for newly synced sessions
    if (outlineService && (result.sessionsIngested > 0 || result.sessionsUpdated > 0)) {
      outlineService.queueOutlineGeneration();
    }

    return result;
  });

  // GET /machines - List registered machines
  fastify.get('/machines', async () => {
    const machines = await fastify.sql<MachineRecord[]>`
      SELECT
        machine_id,
        hostname,
        is_localhost,
        first_seen_at,
        last_sync_at,
        session_count
      FROM sessions.machines
      ORDER BY last_sync_at DESC NULLS LAST
    `;
    return machines;
  });

  // Outline generation endpoints (only if outlineService is available)
  if (outlineService) {
    // POST /sessions/outlines - Manually trigger outline generation
    fastify.post<{
      Body?: { sessionIds?: string[] };
    }>('/sessions/outlines', async (request) => {
      const sessionIds = request.body?.sessionIds;
      const result = await outlineService.generateOutlinesSync(sessionIds);
      return result;
    });

    // GET /sessions/outlines/progress - Check outline generation progress
    fastify.get('/sessions/outlines/progress', async () => {
      // Sessions stuck at outline_attempts >= MAX_OUTLINE_ATTEMPTS - the
      // automatic sweeps have stopped retrying these; they need a code fix
      // or a manual POST /sessions/outlines with explicit sessionIds.
      const [capped] = await fastify.sql<{ capped_count: string }[]>`
        SELECT COUNT(*) as capped_count
        FROM sessions.sessions
        WHERE outline_hash IS DISTINCT FROM transcript_hash
          AND outline_attempts >= ${OutlineService.MAX_OUTLINE_ATTEMPTS}
      `;

      return {
        ...outlineService.getProgress(),
        capped_count: parseInt(capped?.capped_count ?? '0', 10),
      };
    });
  }

  // ── Classification pipeline endpoints (only when enabled) ─────────────────
  if (classificationService) {
    // POST /sessions/classify - Manually trigger a classification sweep
    fastify.post('/sessions/classify', async () => {
      return classificationService.sweep();
    });

    // POST /sessions/classify/backfill?since=ISO - Bounded historical backfill.
    // Deliberately NOT run automatically on deploy (would classify the whole
    // ~2,400-session backlog). Recommended first window: 30 days. `since` is
    // required so a backfill can never be unbounded.
    fastify.post<{ Querystring: { since?: string } }>(
      '/sessions/classify/backfill',
      async (request, reply) => {
        const { since } = request.query;
        if (!since) {
          return reply.status(400).send({
            error: 'since (ISO 8601) is required — backfill must be bounded (e.g. 30 days ago)',
          });
        }
        const sinceDate = new Date(since);
        if (isNaN(sinceDate.getTime())) {
          return reply.status(400).send({ error: 'Invalid since date format' });
        }
        return classificationService.backfillSince(sinceDate);
      }
    );
  }

  if (classificationStore) {
    // GET /sessions/classification/events - Recent classification events
    fastify.get<{
      Querystring: { type?: string; days?: string; limit?: string };
    }>('/sessions/classification/events', async (request) => {
      const { type, days, limit } = request.query;
      const events = await classificationStore.listEvents({
        type,
        days: days ? parseInt(days, 10) : undefined,
        limit: Math.min(parseInt(limit ?? '100', 10) || 100, 500),
      });
      return events;
    });

    // GET /sessions/classification/reports - Recent synthesis + narrative reports
    fastify.get<{
      Querystring: { limit?: string };
    }>('/sessions/classification/reports', async (request) => {
      const limit = Math.min(parseInt(request.query.limit ?? '20', 10) || 20, 100);
      return classificationStore.listReports(limit);
    });
  }

  // POST /sessions/synthesis - Manually run the weekly synthesis + narrative for
  // the last 7 days (or a `week` ending date). Persists; does not deliver a
  // digest (that's the scheduled job's role).
  if (synthesisService) {
    fastify.post<{ Querystring: { ending?: string } }>(
      '/sessions/synthesis',
      async (request, reply) => {
        let period: Period;
        if (request.query.ending) {
          const end = new Date(request.query.ending);
          if (isNaN(end.getTime())) {
            return reply.status(400).send({ error: 'Invalid ending date format' });
          }
          period = lastWeekPeriod(end);
        } else {
          period = lastWeekPeriod();
        }
        const synthesis = await synthesisService.synthesizeWeek(period);
        const narrative = await synthesisService.narrateWeek(period);
        return {
          period: { start: period.startLabel, end: period.endLabel },
          event_count: synthesis.eventCount,
          synthesis: synthesis.report,
          proposals: synthesis.payload,
          narrative: narrative.narrative,
        };
      }
    );
  }
};
