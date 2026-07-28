import { describe, expect, it } from 'bun:test';
import { isApiPath, prefersJson, resolveUnmatched } from './not-found.js';

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8';

describe('unmatched-route resolution (specs/behaviors/http-not-found.md)', () => {
  it('never answers the SPA shell to a non-GET — a write that did not happen is not a 200', () => {
    for (const method of ['DELETE', 'POST', 'PUT', 'PATCH', 'OPTIONS']) {
      // The exact reported footgun: /kitchen/* is SPA route space, so an API
      // client hitting it without the /api prefix used to get 200 + HTML.
      expect(resolveUnmatched({ method, url: '/kitchen/recipes/01JXXXXXXXXXXXXXXXXXXXXXXX' })).toBe('json-404');
      // Even from a browser-shaped Accept — the verb decides, not the header.
      expect(resolveUnmatched({ method, url: '/kitchen/recipes/x', accept: HTML_ACCEPT })).toBe('json-404');
    }
  });

  it('404s unmatched API paths regardless of verb or Accept', () => {
    expect(resolveUnmatched({ method: 'GET', url: '/api/nope' })).toBe('json-404');
    expect(resolveUnmatched({ method: 'GET', url: '/api/nope?x=1', accept: HTML_ACCEPT })).toBe('json-404');
    expect(resolveUnmatched({ method: 'POST', url: '/api' })).toBe('json-404');
  });

  it('matches the API prefix as a whole path segment, not a string prefix', () => {
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/kitchen/entries')).toBe(true);
    expect(isApiPath('/api?x=1')).toBe(true);
    expect(isApiPath('/apiary')).toBe(false);
    expect(isApiPath('/apiary/bees')).toBe(false);
    // A non-API SPA path that merely starts with those letters is still SPA space.
    expect(resolveUnmatched({ method: 'GET', url: '/apiary', accept: HTML_ACCEPT })).toBe('spa-shell');
  });

  it('serves the shell to a real browser navigation so client-side routing keeps working', () => {
    expect(resolveUnmatched({ method: 'GET', url: '/kitchen/entries', accept: HTML_ACCEPT })).toBe('spa-shell');
    expect(resolveUnmatched({ method: 'HEAD', url: '/sessions/deep/link', accept: HTML_ACCEPT })).toBe('spa-shell');
    // No Accept header at all (or a bare wildcard) still navigates.
    expect(resolveUnmatched({ method: 'GET', url: '/kitchen' })).toBe('spa-shell');
    expect(resolveUnmatched({ method: 'GET', url: '/kitchen', accept: '*/*' })).toBe('spa-shell');
  });

  it('404s a GET from a client that asked for JSON and not HTML', () => {
    expect(resolveUnmatched({ method: 'GET', url: '/kitchen/recipes', accept: 'application/json' })).toBe('json-404');
    expect(resolveUnmatched({ method: 'GET', url: '/kitchen/recipes', accept: 'application/problem+json' })).toBe('json-404');
    expect(resolveUnmatched({ method: 'GET', url: '/kitchen/recipes', accept: 'application/json;q=0.9, */*;q=0.1' })).toBe('json-404');
  });

  it('prefersJson requires a named JSON type and no HTML type', () => {
    expect(prefersJson(undefined)).toBe(false);
    expect(prefersJson('*/*')).toBe(false);
    expect(prefersJson('')).toBe(false);
    expect(prefersJson('application/json')).toBe(true);
    expect(prefersJson('APPLICATION/JSON')).toBe(true);
    // A client happy with HTML gets the shell — mixed Accept is not "prefers JSON".
    expect(prefersJson('application/json, text/html')).toBe(false);
    expect(prefersJson(HTML_ACCEPT)).toBe(false);
    expect(prefersJson('text/plain')).toBe(false);
  });
});
