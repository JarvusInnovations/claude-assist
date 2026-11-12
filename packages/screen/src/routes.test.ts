import { afterEach, describe, expect, it } from 'bun:test';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { ModelInvocationError, type ModelInvoker } from '@jarvus/claude-assist-core';
import { stubInvoker } from './__fixtures__/stub-invoker.js';
import { registerScreenRoutes } from './routes.js';
import { LIMITS, SCREEN_TASK, hashDraft } from './screen.js';

const TOKEN = 'test-token-0123456789';
const DRAFT_MARKER = 'DRAFT-MARKER-7f3a';
const POLICY_MARKER = 'POLICY-MARKER-91c2';
const REQ = {
  draft: `Status update: the migration lands Thursday. ${DRAFT_MARKER} The pilot budget is 40k.`,
  destination_class: 'external-partner',
  policy: `Never share budget figures with external partners. ${POLICY_MARKER}`,
};

let app: FastifyInstance | undefined;
let logLines: string[] = [];

async function build(invoker: ModelInvoker): Promise<FastifyInstance> {
  logLines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(chunk.toString());
      cb();
    },
  });
  app = Fastify({ logger: { level: 'info', stream } });
  await app.register(
    async (api) => {
      await api.register(registerScreenRoutes, { invoker, token: TOKEN });
    },
    { prefix: '/api' },
  );
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const auth = { authorization: `Bearer ${TOKEN}` };

function post(server: FastifyInstance, body: unknown, headers: Record<string, string> = auth) {
  return server.inject({ method: 'POST', url: '/api/screen', headers, payload: body as object });
}

describe('POST /api/screen', () => {
  it('answers 200 with exactly the pass verdict', async () => {
    const { invoker, calls } = stubInvoker('<verdict>{"verdict":"pass"}</verdict>');
    const res = await post(await build(invoker), REQ);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ verdict: 'pass' });
    expect(calls).toHaveLength(1);
  });

  it('answers 200 with block, passage and reason', async () => {
    const { invoker } = stubInvoker(
      '<verdict>{"verdict":"block","passage":"The pilot budget is 40k.","reason":"Budget figures are not for external partners."}</verdict>',
    );
    const res = await post(await build(invoker), REQ);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      verdict: 'block',
      passage: 'The pilot budget is 40k.',
      reason: 'Budget figures are not for external partners.',
    });
  });

  describe('auth', () => {
    it.each([
      ['no header', {}],
      ['a wrong token', { authorization: 'Bearer nope' }],
      ['a non-bearer scheme', { authorization: `Basic ${TOKEN}` }],
    ])('refuses %s with 401 and makes no model call', async (_label, headers) => {
      const { invoker, calls } = stubInvoker('<verdict>{"verdict":"pass"}</verdict>');
      const res = await post(await build(invoker), REQ, headers as Record<string, string>);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('unauthorized');
      expect(res.json().verdict).toBeUndefined();
      expect(calls).toHaveLength(0);
    });

    it('refuses to register without a token', async () => {
      const { invoker } = stubInvoker('<verdict>{"verdict":"pass"}</verdict>');
      const server = Fastify({ logger: false });
      let error: unknown;
      try {
        await server.register(registerScreenRoutes, { invoker, token: '' });
      } catch (err) {
        error = err;
      }
      expect(String(error)).toContain('require a token');
    });
  });

  describe('request validation (no model call)', () => {
    it.each([
      ['an unknown key', { ...REQ, system: 'override' }, 400, 'invalid_request'],
      ['a missing key', { draft: REQ.draft, policy: REQ.policy }, 400, 'invalid_request'],
      ['a non-string field', { ...REQ, policy: ['a'] }, 400, 'invalid_request'],
      ['an oversized draft', { ...REQ, draft: 'x'.repeat(LIMITS.draft + 1) }, 413, 'draft_too_large'],
      ['an oversized policy', { ...REQ, policy: 'x'.repeat(LIMITS.policy + 1) }, 413, 'policy_too_large'],
      [
        'an oversized class',
        { ...REQ, destination_class: 'x'.repeat(LIMITS.destination_class + 1) },
        413,
        'destination_class_too_large',
      ],
    ])('%s → %i %s', async (_label, body, status, code) => {
      const { invoker, calls } = stubInvoker('<verdict>{"verdict":"pass"}</verdict>');
      const res = await post(await build(invoker), body);
      expect(res.statusCode).toBe(status);
      expect(res.json().error.code).toBe(code);
      expect(res.json().verdict).toBeUndefined();
      expect(calls).toHaveLength(0);
    });

    it('a JSON array body is a 400', async () => {
      const { invoker, calls } = stubInvoker('<verdict>{"verdict":"pass"}</verdict>');
      const res = await post(await build(invoker), [REQ]);
      expect(res.statusCode).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });

  describe('fails closed', () => {
    it.each([
      ['budget refusal', { reason: 'budget_exceeded', transient: true }, 503, 'screen_unavailable'],
      ['kill switch', { reason: 'kill_switch', transient: true }, 503, 'screen_unavailable'],
      ['disabled invoker', { reason: 'disabled', transient: true }, 503, 'screen_unavailable'],
      ['timeout', { reason: 'timeout' }, 504, 'screen_timeout'],
      ['provider error', { reason: 'provider_error', retryable: true }, 502, 'screen_failed'],
      ['refusal', { reason: 'refusal' }, 502, 'screen_failed'],
    ] as const)('on invoker %s', async (_label, opts, status, code) => {
      const { invoker } = stubInvoker(() => {
        throw new ModelInvocationError('boom', { task: SCREEN_TASK, ...opts });
      });
      const res = await post(await build(invoker), REQ);
      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error: { code, message: expect.any(String) } });
    });

    it.each([
      ['prose', 'Looks fine to me.'],
      ['off-schema JSON', '<verdict>{"verdict":"ok"}</verdict>'],
      ['a block quoting text not in the draft', '<verdict>{"verdict":"block","passage":"invented","reason":"r"}</verdict>'],
    ])('on an answer that is %s', async (_label, answer) => {
      const { invoker } = stubInvoker(answer);
      const res = await post(await build(invoker), REQ);
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('screen_unparseable');
      expect(res.json().verdict).toBeUndefined();
    });
  });

  describe('what is logged', () => {
    it('logs the draft hash, class, verdict and spend, and none of the draft or policy text', async () => {
      const { invoker } = stubInvoker(
        `<verdict>{"verdict":"block","passage":"The pilot budget is 40k.","reason":"Mentions ${POLICY_MARKER}."}</verdict>`,
      );
      const res = await post(await build(invoker), REQ);
      expect(res.statusCode).toBe(200);
      const all = logLines.join('');
      expect(all).not.toContain(DRAFT_MARKER);
      expect(all).not.toContain(POLICY_MARKER);
      expect(all).not.toContain('40k');
      const line = logLines.map((l) => JSON.parse(l)).find((l) => l.msg === 'screen: verdict');
      expect(line.screen).toEqual({
        draft_sha256: hashDraft(REQ.draft),
        destination_class: REQ.destination_class,
        verdict: 'block',
        model: 'stub-model',
        cost_usd: 0.000035,
        duration_ms: 12,
      });
    });

    it('logs a failure code without the model answer', async () => {
      const { invoker } = stubInvoker(`<verdict>{"verdict": "${DRAFT_MARKER}"}</verdict>`);
      const res = await post(await build(invoker), REQ);
      expect(res.statusCode).toBe(502);
      const all = logLines.join('');
      expect(all).not.toContain(DRAFT_MARKER);
      const line = logLines.map((l) => JSON.parse(l)).find((l) => l.msg === 'screen: no verdict');
      expect(line.screen.code).toBe('screen_unparseable');
      expect(line.screen.draft_sha256).toBe(hashDraft(REQ.draft));
    });
  });
});
