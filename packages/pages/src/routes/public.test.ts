import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { MemoryPagesStore } from '../memory-store.js';
import { registerPagesPublicRoutes } from './public.js';
import { PAGE_CSP } from '../csp.js';

/**
 * A page body exercising the glyph classes worksheets actually use: em dash,
 * degree sign, check, multiplication sign, almost-equal, an accented letter,
 * and an arrow. Every one of these mojibakes when the response omits a charset.
 */
const NON_ASCII_HTML = '<h1>Prep — 425 °F</h1><p>✓ 3 × 120 g ≈ 360 g · sauté → purée</p>';

describe('pages public serving surface', () => {
  let fastify: FastifyInstance;
  let store: MemoryPagesStore;

  beforeEach(async () => {
    fastify = Fastify({ logger: false });
    store = new MemoryPagesStore();
    await fastify.register(registerPagesPublicRoutes, { store });
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  describe('charset (claude-assist#129)', () => {
    it('serves a page as text/html with an explicit charset=utf-8', async () => {
      await store.publish({ slug: 'a-worksheet', title: 'A Worksheet', html: NON_ASCII_HTML });

      const response = await fastify.inject({ method: 'GET', url: '/pages/a-worksheet' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    });

    it('round-trips non-ASCII glyphs byte-for-byte through publish and serve', async () => {
      await store.publish({ slug: 'a-worksheet', title: 'A Worksheet', html: NON_ASCII_HTML });

      const response = await fastify.inject({ method: 'GET', url: '/pages/a-worksheet' });

      // Decode the raw bytes as UTF-8 — what a browser honoring the header does.
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(response.rawPayload);
      expect(decoded).toBe(NON_ASCII_HTML);
      for (const glyph of ['—', '°', '✓', '×', '≈', '·', 'é', '→']) {
        expect(decoded).toContain(glyph);
      }
      // No replacement character anywhere — the tell of a mis-decoded body.
      expect(decoded).not.toContain('�');
      // Byte length exceeds character length: the payload really is multibyte
      // UTF-8, not a latin1 transcoding that happened to survive.
      expect(response.rawPayload.length).toBeGreaterThan(NON_ASCII_HTML.length);
      expect(Number(response.headers['content-length'])).toBe(response.rawPayload.length);
    });

    it('serves the page index and the helper script with a charset too', async () => {
      await store.publish({ slug: 'a-worksheet', title: 'Prep — a grain bowl', html: '<p>hi</p>' });

      const index = await fastify.inject({ method: 'GET', url: '/pages' });
      expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(new TextDecoder('utf-8', { fatal: true }).decode(index.rawPayload)).toContain(
        'Prep — a grain bowl'
      );

      const helper = await fastify.inject({ method: 'GET', url: '/pages/_helper.js' });
      expect(helper.statusCode).toBe(200);
      expect(helper.headers['content-type']).toBe('application/javascript; charset=utf-8');
    });

    it('serves the not-found body with a charset as well', async () => {
      const response = await fastify.inject({ method: 'GET', url: '/pages/no-such-page' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    });
  });

  it('keeps serving the published HTML unmodified, with the module CSP', async () => {
    await store.publish({ slug: 'a-worksheet', title: 'A Worksheet', html: NON_ASCII_HTML });

    const response = await fastify.inject({ method: 'GET', url: '/pages/a-worksheet' });

    expect(response.body).toBe(NON_ASCII_HTML);
    expect(response.headers['content-security-policy']).toBe(PAGE_CSP);
  });
});
