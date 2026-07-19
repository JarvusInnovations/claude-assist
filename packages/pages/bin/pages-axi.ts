#!/usr/bin/env bun
/**
 * pages-axi — thin CLI over the pages module's API, so an agent session can
 * publish a page or drain its response queue with one command.
 *
 * Usage:
 *   pages-axi publish <file> --slug <slug> [--title <title>] [--digest-optin]
 *   pages-axi list
 *   pages-axi responses <slug> [--since <iso>] [--unprocessed]
 *   pages-axi mark-processed <slug> <id> --by <name>
 *   pages-axi archive <slug>
 *
 * Server defaults to http://localhost:2529; override with CLAUDE_ASSIST_SERVER
 * (same convention as the other claude-assist axi CLIs). Output is TOON.
 */

import {
  resolveServer,
  parseFlags,
  extractHtmlTitle,
  titleFromSlug,
  renderObject,
  renderTable,
  renderHelp,
  renderOutput,
  formatRelativeTime,
} from '../src/axi.js';

const HELP = `usage: pages-axi <command> [args] [flags]

commands:
  publish <file> --slug <slug> [--title <title>] [--digest-optin]
                       publish (or republish) a self-contained HTML file;
                       prints the page's stable URL. Republishing a slug adds
                       a new version. --title defaults to the file's <title>,
                       then to the slug. --digest-optin batches response
                       notifications into the digest tier.
  list                 active pages, newest first
  responses <slug> [--since <iso>] [--unprocessed]
                       read a page's response queue (oldest first)
  mark-processed <slug> <id> --by <name>
                       mark one response handled
  archive <slug>       remove a page from the index (storage retained)

env: CLAUDE_ASSIST_SERVER (default http://localhost:2529)

examples:
  pages-axi publish ./review.html --slug design-review
  pages-axi responses design-review --unprocessed
  pages-axi mark-processed design-review 3 --by my-session
`;

const server = resolveServer();

function fail(message: string, code = 1): never {
  console.error(`pages-axi: ${message}`);
  process.exit(code);
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`${server}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(
      `cannot reach server at ${server} (${error instanceof Error ? error.message : String(error)})` +
        ' — set CLAUDE_ASSIST_SERVER or start the server'
    );
  }
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error) message = parsed.error;
    } catch {
      // keep raw text
    }
    fail(`server returned ${response.status}: ${message}`);
  }
  return text ? JSON.parse(text) : null;
}

async function publish(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv, ['slug', 'title'], ['digest-optin']);
  const file = positional[0];
  const slug = flags.slug as string | undefined;
  if (!file || !slug) fail('usage: pages-axi publish <file> --slug <slug> [--title <title>]', 2);

  const htmlFile = Bun.file(file);
  if (!(await htmlFile.exists())) fail(`file not found: ${file}`, 2);
  const html = await htmlFile.text();
  if (!html.trim()) fail(`file is empty: ${file}`, 2);

  const title = (flags.title as string | undefined) ?? extractHtmlTitle(html) ?? titleFromSlug(slug);

  const result = await api('POST', '/api/pages', {
    slug,
    title,
    html,
    ...(flags['digest-optin'] ? { digest_optin: true } : {}),
  });

  console.log(
    renderOutput([
      renderObject('published', {
        slug: result.slug,
        title: result.title,
        url: result.url,
        version: result.version,
        created: result.created,
      }),
      renderHelp([
        `Run \`pages-axi responses ${result.slug}\` to read collected responses`,
        `Republish with the same --slug to push a new version at the same URL`,
      ]),
    ])
  );
}

async function list(): Promise<void> {
  const result = await api('GET', '/api/pages');
  const rows = (result.pages as Record<string, unknown>[]).map((p) => ({
    slug: p.slug,
    title: p.title,
    updated: formatRelativeTime(p.updated_at),
    url: p.url,
  }));
  console.log(
    renderOutput([
      renderTable('pages', rows, ['slug', 'title', 'updated', 'url']),
      renderHelp(
        rows.length > 0
          ? [`Run \`pages-axi responses <slug>\` to read a page's response queue`]
          : [`Run \`pages-axi publish <file> --slug <slug>\` to publish a page`]
      ),
    ])
  );
}

async function responses(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv, ['since'], ['unprocessed']);
  const slug = positional[0];
  if (!slug) fail('usage: pages-axi responses <slug> [--since <iso>] [--unprocessed]', 2);

  const query = new URLSearchParams();
  if (flags.since) query.set('since', flags.since as string);
  if (flags.unprocessed) query.set('unprocessed', 'true');
  const qs = query.toString();

  const result = await api('GET', `/api/pages/${encodeURIComponent(slug)}/responses${qs ? `?${qs}` : ''}`);
  const rows = (result.responses as Record<string, unknown>[]).map((r) => ({
    id: r.id,
    payload: JSON.stringify(r.payload),
    anchor: r.anchor ?? '',
    note: r.note ?? '',
    received: formatRelativeTime(r.created_at),
    processed_by: r.processed_by ?? '',
  }));
  console.log(
    renderOutput([
      renderTable('responses', rows, ['id', 'payload', 'anchor', 'note', 'received', 'processed_by']),
      renderHelp(
        rows.length > 0
          ? [`Run \`pages-axi mark-processed ${slug} <id> --by <name>\` after handling one`]
          : []
      ),
    ])
  );
}

async function markProcessed(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv, ['by']);
  const [slug, id] = positional;
  const by = flags.by as string | undefined;
  if (!slug || !id || !by) fail('usage: pages-axi mark-processed <slug> <id> --by <name>', 2);

  const result = await api(
    'POST',
    `/api/pages/${encodeURIComponent(slug)}/responses/${encodeURIComponent(id)}/processed`,
    { processed_by: by }
  );
  console.log(
    renderObject('processed', {
      id: result.id,
      processed_by: result.processed_by,
      processed_at: result.processed_at,
    })
  );
}

async function archive(argv: string[]): Promise<void> {
  const { positional } = parseFlags(argv, []);
  const slug = positional[0];
  if (!slug) fail('usage: pages-axi archive <slug>', 2);

  const result = await api('POST', `/api/pages/${encodeURIComponent(slug)}/archive`);
  console.log(
    renderOutput([
      renderObject('archived', { slug: result.slug, archived_at: result.archived_at }),
      renderHelp([`Republish the slug to reactivate it at the same URL`]),
    ])
  );
}

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case 'publish':
      await publish(rest);
      break;
    case 'list':
      await list();
      break;
    case 'responses':
      await responses(rest);
      break;
    case 'mark-processed':
      await markProcessed(rest);
      break;
    case 'archive':
      await archive(rest);
      break;
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP);
      process.exit(command === undefined ? 2 : 0);
      break;
    default:
      fail(`unknown command: ${command}\n\n${HELP}`, 2);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), 2);
}
