import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { SyncService } from './sync.js';
import type { OutlineService } from './outline.js';
import type {
  PushPayload,
  SessionRecord,
  MachineRecord,
  InventoryPayload,
} from './types.js';
import { serializeTranscript } from './transcript.js';

export interface RoutesConfig {
  syncService: SyncService;
  outlineService: OutlineService | null;
}

/**
 * Register session API routes
 */
export const registerRoutes: FastifyPluginAsync<RoutesConfig> = async (
  fastify,
  { syncService, outlineService }
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
      machine?: string;
      project?: string;
      limit?: string;
      offset?: string;
      include_empty?: string;
    };
  }>('/sessions', async (request, reply) => {
    const {
      search,
      days = '30',
      since,
      until,
      forever,
      tools,
      machine,
      project,
      limit = '20',
      offset = '0',
      include_empty,
    } = request.query;
    const excludeEmpty = include_empty !== 'true';

    const daysNum = parseInt(days, 10) || 30;
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
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
      // Full-text search query
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
          s.outline,
          m.machine_id,
          ts_rank(s.search_vector, websearch_to_tsquery('english', ${search})) as rank
        FROM sessions.sessions s
        JOIN sessions.machines m ON s.machine_id = m.id
        WHERE s.search_vector @@ websearch_to_tsquery('english', ${search})
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
          ${machine ? fastify.sql`AND m.machine_id = ${machine}` : fastify.sql``}
          ${project ? fastify.sql`AND s.project_path ILIKE ${'%' + project + '%'}` : fastify.sql``}
          ${tools ? fastify.sql`AND s.tools_used ?| ${tools.split(',').map(t => t.trim())}` : fastify.sql``}
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
          s.outline,
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
          ${machine ? fastify.sql`AND m.machine_id = ${machine}` : fastify.sql``}
          ${project ? fastify.sql`AND s.project_path ILIKE ${'%' + project + '%'}` : fastify.sql``}
          ${tools ? fastify.sql`AND s.tools_used ?| ${tools.split(',').map(t => t.trim())}` : fastify.sql``}
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
      message_count: s.message_count,
      tools_used: s.tools_used,
      files_touched: s.files_touched,
      machine: s.machine_id,
    }));
  });

  // GET /sessions/:id - Get session details
  fastify.get<{
    Params: { id: string };
    Querystring: { with_raw_messages?: string };
  }>('/sessions/:id', async (request, reply) => {
    const { id } = request.params;
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
      input_tokens: session.input_tokens,
      output_tokens: session.output_tokens,
      cache_read_tokens: session.cache_read_tokens,
      claude_version: session.claude_version,
      outline: session.outline,
      outline_hash: session.outline_hash,
      models_used: session.models_used,
      model_tokens: session.model_tokens,
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
  fastify.get<{
    Params: { id: string };
  }>('/sessions/:id/transcript', async (request, reply) => {
    const { id } = request.params;

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
    const transcript = serializeTranscript(session.raw_transcript);

    reply.type('text/plain');
    return transcript;
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

    return {
      period_days: daysNum,
      ...stats[0],
      top_tools: topTools,
      top_models: topModels,
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

    return result;
  });

  // POST /sessions/sync - Manually trigger local sync
  fastify.post('/sessions/sync', async () => {
    const result = await syncService.syncLocal();

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
      return outlineService.getProgress();
    });
  }
};
