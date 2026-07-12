import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_SERVER,
  resolveServer,
  renderObject,
  renderTable,
  renderHelp,
  renderOutput,
  formatRelativeTime,
  parseFlags,
  extractHtmlTitle,
  titleFromSlug,
} from './axi.js';

describe('resolveServer', () => {
  it('defaults to localhost and strips trailing slashes from the env override', () => {
    expect(resolveServer({})).toBe(DEFAULT_SERVER);
    expect(resolveServer({ CLAUDE_ASSIST_SERVER: 'http://box:2529/' })).toBe('http://box:2529');
    expect(resolveServer({ CLAUDE_ASSIST_SERVER: '  ' })).toBe(DEFAULT_SERVER);
  });
});

describe('TOON rendering', () => {
  it('renders a labeled object as key: value lines', () => {
    expect(renderObject('published', { slug: 'my-page', version: 2, created: false })).toBe(
      'published:\n  slug: my-page\n  version: 2\n  created: false'
    );
  });

  it('quotes values containing TOON-ambiguous characters', () => {
    const out = renderObject('x', { title: 'a, b: c', empty: '', missing: null });
    expect(out).toContain('  title: "a, b: c"');
    expect(out).toContain('  empty: ""');
    expect(out).toContain('  missing: null');
  });

  it('renders a table with a {cols} header and CSV rows', () => {
    const rows = [
      { slug: 'a', title: 'Page A' },
      { slug: 'b', title: 'Page, B' },
    ];
    expect(renderTable('pages', rows, ['slug', 'title'])).toBe(
      'pages[2]{slug,title}:\n  a,Page A\n  b,"Page, B"'
    );
  });

  it('renders an empty collection as label[0]', () => {
    expect(renderTable('pages', [])).toBe('pages[0]');
  });

  it('renders help blocks and drops empty output blocks', () => {
    expect(renderHelp(['do a thing'])).toBe('help[1]:\n  do a thing');
    expect(renderHelp([])).toBe('');
    expect(renderOutput(['a', '', 'b'])).toBe('a\nb');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0);
  it('formats past timestamps at sensible granularities', () => {
    expect(formatRelativeTime(new Date(now - 30_000).toISOString(), now)).toBe('just now');
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5m ago');
    expect(formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3h ago');
    expect(formatRelativeTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2d ago');
  });
  it('handles missing and malformed values', () => {
    expect(formatRelativeTime(null, now)).toBe('unknown');
    expect(formatRelativeTime('not-a-date', now)).toBe('unknown');
  });
});

describe('parseFlags', () => {
  it('separates positionals from value and boolean flags', () => {
    const parsed = parseFlags(
      ['file.html', '--slug', 'my-page', '--digest-optin'],
      ['slug', 'title'],
      ['digest-optin']
    );
    expect(parsed.positional).toEqual(['file.html']);
    expect(parsed.flags).toEqual({ slug: 'my-page', 'digest-optin': true });
  });

  it('throws on unknown flags and missing values', () => {
    expect(() => parseFlags(['--bogus'], ['slug'])).toThrow('unknown flag --bogus');
    expect(() => parseFlags(['--slug'], ['slug'])).toThrow('missing value for --slug');
  });
});

describe('publish title fallbacks', () => {
  it('extracts the document <title>', () => {
    expect(extractHtmlTitle('<html><head><title> My Review </title></head></html>')).toBe(
      'My Review'
    );
    expect(extractHtmlTitle('<TITLE lang="en">Caps</TITLE>')).toBe('Caps');
  });
  it('returns null when there is no usable title', () => {
    expect(extractHtmlTitle('<html><body>no title</body></html>')).toBeNull();
    expect(extractHtmlTitle('<title>   </title>')).toBeNull();
  });
  it('derives a Title Case fallback from the slug', () => {
    expect(titleFromSlug('design-review-v2')).toBe('Design Review V2');
  });
});
