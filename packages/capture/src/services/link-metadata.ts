/**
 * URL extraction + link metadata fetching.
 *
 * A URL-only capture is the primary link-dropbox case (replacing the
 * open-tabs graveyard), so title/description extraction happens during the
 * classification pass and rides along in classification.links. Fetches are
 * best-effort and never throw — a dead link is still worth keeping.
 */

import type { LinkMetadata } from '../types.js';

const URL_REGEX = /https?:\/\/[^\s<>"'\])]+/gi;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_URLS_PER_CAPTURE = 5;
const USER_AGENT =
  'Mozilla/5.0 (compatible; claude-assist-capture/0.1; +https://github.com/JarvusInnovations/claude-assist)';

/** Extract http(s) URLs from free text, trimming trailing punctuation */
export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX) ?? [];
  const cleaned = matches
    .map((url) => url.replace(/[.,;:!?)\]}>]+$/, ''))
    .filter((url) => {
      try {
        new URL(url);
        return true;
      } catch {
        return false;
      }
    });
  return [...new Set(cleaned)];
}

/**
 * True when the capture is a pure link drop: after removing every URL,
 * nothing meaningful remains in the text.
 */
export function isUrlOnly(text: string, urls: string[]): boolean {
  if (urls.length === 0) return false;
  let remainder = text;
  for (const url of urls) {
    remainder = remainder.split(url).join(' ');
  }
  return remainder.replace(/[\s.,;:!?()\[\]{}<>"'-]+/g, '') === '';
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

function matchMetaContent(html: string, attr: 'name' | 'property', key: string): string | undefined {
  // Handles both attribute orders: <meta name=... content=...> and <meta content=... name=...>
  const patterns = [
    new RegExp(`<meta[^>]+${attr}\\s*=\\s*["']${key}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*${attr}\\s*=\\s*["']${key}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeEntities(match[1]);
  }
  return undefined;
}

/** Parse title/description/site_name out of an HTML document (exported for tests) */
export function parseHtmlMetadata(html: string): Pick<LinkMetadata, 'title' | 'description' | 'site_name'> {
  const head = html.slice(0, 200_000);
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title =
    matchMetaContent(head, 'property', 'og:title') ??
    (titleTag ? decodeEntities(titleTag.replace(/\s+/g, ' ')) : undefined);
  const description =
    matchMetaContent(head, 'property', 'og:description') ??
    matchMetaContent(head, 'name', 'description');
  const siteName = matchMetaContent(head, 'property', 'og:site_name');
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(siteName ? { site_name: siteName } : {}),
  };
}

async function readCapped(response: Response, cap: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(Math.min(total, cap));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, merged.length - offset));
    merged.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= merged.length) break;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

/** Fetch metadata for one URL. Never throws; failures land in fetch_error. */
export async function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      },
    });

    const finalUrl = response.url && response.url !== url ? { final_url: response.url } : {};

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { url, ...finalUrl, fetch_error: `HTTP ${response.status}` };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('html')) {
      await response.body?.cancel().catch(() => {});
      return { url, ...finalUrl };
    }

    const html = await readCapped(response, MAX_BODY_BYTES);
    return { url, ...finalUrl, ...parseHtmlMetadata(html) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { url, fetch_error: message };
  }
}

/** Fetch metadata for a capture's URLs (bounded) */
export async function fetchAllLinkMetadata(urls: string[]): Promise<LinkMetadata[]> {
  const bounded = urls.slice(0, MAX_URLS_PER_CAPTURE);
  return Promise.all(bounded.map((url) => fetchLinkMetadata(url)));
}
