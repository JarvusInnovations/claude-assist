/**
 * pages-axi — thin CLI over the pages module's API, so an agent session can
 * publish a page or a worksheet and drain its response queue with one command.
 *
 * Server defaults to http://localhost:2529; override with CLAUDE_ASSIST_SERVER
 * (same convention as the other claude-assist axi CLIs). Output is TOON.
 *
 * Runs under NODE once bundled (specs/modules/pages.md § Agent tooling), so
 * nothing here may use a Bun-only global — file reads go through node:fs.
 */

import { readFile } from 'node:fs/promises';
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
} from './index.js';
import { COMMAND_GROUPS, DESCRIPTION, WORKSHEET_SHAPE } from './reference.js';

function buildHelp(): string {
  const groups = COMMAND_GROUPS.map((group) => {
    const items = group.commands
      .map((c) => `  ${c.usage}\n      ${c.summary.replace(/\s+/g, ' ')}`)
      .join('\n');
    return `${group.group.toLowerCase()}:\n${items}`;
  }).join('\n\n');

  return `usage: pages-axi <command> [args] [flags]

${DESCRIPTION}

${groups}

worksheet definition shape (for publish-worksheet):
${WORKSHEET_SHAPE.split('\n')
  .map((l) => `  ${l}`)
  .join('\n')}

env: CLAUDE_ASSIST_SERVER (default http://localhost:2529)

examples:
  pages-axi                                        # home view: pages + backlog
  pages-axi publish ./review.html --slug design-review
  pages-axi publish-worksheet ./prep.json --slug prep-today
  pages-axi responses design-review --unprocessed
  pages-axi mark-processed design-review 3 --by my-session
`;
}

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

/** Read a file argument, or stdin when the path is `-`. */
async function readInput(file: string): Promise<string> {
  if (file === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  try {
    return await readFile(file, 'utf8');
  } catch {
    fail(`file not found or unreadable: ${file}`, 2);
  }
}

function reportPublished(result: any, extraHelp: string[] = []): void {
  console.log(
    renderOutput([
      renderObject('published', {
        slug: result.slug,
        title: result.title,
        url: result.url,
        version: result.version,
        created: result.created,
        ...(result.worksheet ? { worksheet: result.worksheet } : {}),
        ...(result.cook_mode ? { cook_mode: result.cook_mode } : {}),
      }),
      renderHelp([
        `Run \`pages-axi responses ${result.slug}\` to read collected responses`,
        `Republish with the same --slug to push a new version at the same URL`,
        ...extraHelp,
      ]),
    ])
  );
}

async function publish(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv, ['slug', 'title'], ['digest-optin']);
  const file = positional[0];
  const slug = flags.slug as string | undefined;
  if (!file || !slug) fail('usage: pages-axi publish <file> --slug <slug> [--title <title>]', 2);

  const html = await readInput(file);
  if (!html.trim()) fail(`file is empty: ${file}`, 2);

  const title = (flags.title as string | undefined) ?? extractHtmlTitle(html) ?? titleFromSlug(slug);

  reportPublished(
    await api('POST', '/api/pages', {
      slug,
      title,
      html,
      ...(flags['digest-optin'] ? { digest_optin: true } : {}),
    })
  );
}

/**
 * Publish the WORKSHEET half of POST /api/pages. The definition is posted
 * through untouched: this CLI validates that it is JSON and nothing more, so a
 * `cook_mode` directive — whose meaning belongs to a domain module — passes as
 * opaque data (specs/modules/pages.md § The CLI carries no domain vocabulary).
 */
async function publishWorksheet(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv, ['slug', 'title'], ['digest-optin']);
  const file = positional[0];
  const slug = flags.slug as string | undefined;
  if (!file || !slug) {
    fail('usage: pages-axi publish-worksheet <definition.json> --slug <slug> [--title <title>]', 2);
  }

  const raw = await readInput(file);
  if (!raw.trim()) fail(`definition is empty: ${file}`, 2);

  let worksheet: unknown;
  try {
    worksheet = JSON.parse(raw);
  } catch (error) {
    fail(
      `definition is not valid JSON (${error instanceof Error ? error.message : String(error)})` +
        `\n\nexpected shape:\n${WORKSHEET_SHAPE}`,
      2
    );
  }

  const title = (flags.title as string | undefined) ?? titleFromSlug(slug);

  reportPublished(
    await api('POST', '/api/pages', {
      slug,
      title,
      worksheet,
      ...(flags['digest-optin'] ? { digest_optin: true } : {}),
    }),
    ['A submission computes its totals server-side — the page never states results']
  );
}

interface PageRow {
  slug: string;
  title: string;
  url: string;
  updated_at: string;
  response_count?: number;
  unprocessed_count?: number;
}

async function fetchPages(): Promise<PageRow[]> {
  const result = await api('GET', '/api/pages');
  return (result.pages ?? []) as PageRow[];
}

function pageRows(pages: PageRow[]) {
  return pages.map((p) => ({
    slug: p.slug,
    title: p.title,
    updated: formatRelativeTime(p.updated_at),
    responses: p.response_count ?? 0,
    unprocessed: p.unprocessed_count ?? 0,
    url: p.url,
  }));
}

const PAGE_COLUMNS = ['slug', 'title', 'updated', 'responses', 'unprocessed', 'url'];

async function list(): Promise<void> {
  const pages = await fetchPages();
  const rows = pageRows(pages);
  console.log(
    renderOutput([
      renderTable('pages', rows, PAGE_COLUMNS),
      renderHelp(
        rows.length > 0
          ? [`Run \`pages-axi responses <slug>\` to read a page's response queue`]
          : [`Run \`pages-axi publish <file> --slug <slug>\` to publish a page`]
      ),
    ])
  );
}

/**
 * The home view (bare invocation): active pages plus the backlog signal.
 * § Principles — "a page's status is its response backlog" — so the count of
 * unhandled responses leads, and a session opening cold sees what is waiting
 * without having to ask a second question.
 */
async function home(): Promise<void> {
  const pages = await fetchPages();
  const backlog = pages.reduce((sum, p) => sum + (p.unprocessed_count ?? 0), 0);
  const waiting = pages.filter((p) => (p.unprocessed_count ?? 0) > 0);

  console.log(
    renderOutput([
      renderObject('pages-axi', {
        server,
        active_pages: pages.length,
        unprocessed_responses: backlog,
      }),
      renderTable('pages', pageRows(pages).slice(0, 10), PAGE_COLUMNS),
      renderHelp([
        // Cap the per-page nudges: an instance with a long backlog would
        // otherwise bury the rest of the help under one line per page.
        ...waiting
          .slice(0, 3)
          .map(
            (p) =>
              `Run \`pages-axi responses ${p.slug} --unprocessed\` — ${p.unprocessed_count} waiting`
          ),
        ...(waiting.length > 3
          ? [`${waiting.length - 3} more pages have unhandled responses — \`pages-axi list\``]
          : []),
        `Run \`pages-axi publish-worksheet <def.json> --slug <slug>\` to collect measured quantities`,
        `Run \`pages-axi --help\` for the full command list`,
      ])
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

  const result = await api(
    'GET',
    `/api/pages/${encodeURIComponent(slug)}/responses${qs ? `?${qs}` : ''}`
  );
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
    case 'publish-worksheet':
      await publishWorksheet(rest);
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
      await home();
      break;
    case '-h':
    case '--help':
    case 'help':
      console.log(buildHelp());
      break;
    default:
      fail(`unknown command: ${command}\n\n${buildHelp()}`, 2);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), 2);
}
