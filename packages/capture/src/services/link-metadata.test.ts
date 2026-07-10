import { describe, expect, it } from 'bun:test';
import { extractUrls, isUrlOnly, parseHtmlMetadata } from './link-metadata.js';

describe('extractUrls', () => {
  it('finds URLs embedded in text', () => {
    expect(extractUrls('check out https://example.com/a and http://foo.bar/b?x=1')).toEqual([
      'https://example.com/a',
      'http://foo.bar/b?x=1',
    ]);
  });

  it('trims trailing punctuation', () => {
    expect(extractUrls('see https://example.com/page.')).toEqual(['https://example.com/page']);
    expect(extractUrls('(https://example.com/page)')).toEqual(['https://example.com/page']);
  });

  it('dedupes', () => {
    expect(extractUrls('https://a.com https://a.com')).toEqual(['https://a.com']);
  });

  it('returns empty for plain text', () => {
    expect(extractUrls('no links here, just thoughts')).toEqual([]);
  });
});

describe('isUrlOnly', () => {
  it('detects the pure link-dropbox case', () => {
    expect(isUrlOnly('https://example.com/article', ['https://example.com/article'])).toBe(true);
    expect(isUrlOnly('  https://a.com \n https://b.com ', ['https://a.com', 'https://b.com'])).toBe(
      true
    );
  });

  it('is false when the capture has commentary', () => {
    expect(
      isUrlOnly('great piece on capture UIs https://example.com', ['https://example.com'])
    ).toBe(false);
  });

  it('is false with no URLs at all', () => {
    expect(isUrlOnly('just a thought', [])).toBe(false);
  });
});

describe('parseHtmlMetadata', () => {
  it('prefers og tags and falls back to title/description', () => {
    const html = `<html><head>
      <title>Fallback Title</title>
      <meta property="og:title" content="OG Title" />
      <meta name="description" content="Plain description">
      <meta property="og:site_name" content="Example Site"/>
    </head><body></body></html>`;
    expect(parseHtmlMetadata(html)).toEqual({
      title: 'OG Title',
      description: 'Plain description',
      site_name: 'Example Site',
    });
  });

  it('uses the title tag when og:title is missing, decoding entities', () => {
    const html = '<head><title>Ben &amp; Jerry&#39;s\n  News</title></head>';
    expect(parseHtmlMetadata(html).title).toBe("Ben & Jerry's News");
  });

  it('handles reversed meta attribute order', () => {
    const html = '<meta content="Reversed" property="og:title">';
    expect(parseHtmlMetadata(html).title).toBe('Reversed');
  });

  it('returns empty object for metadata-free documents', () => {
    expect(parseHtmlMetadata('<html><body>hi</body></html>')).toEqual({});
  });
});
