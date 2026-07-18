#!/usr/bin/env bun
/**
 * Terminal capture client — post a thought and get on with your day.
 *
 * Usage:
 *   capture "some stray thought"
 *   capture https://example.com/article        # link dropbox
 *   capture -t reading -t ai "url or thought"  # with tags
 *   echo "piped thought" | capture
 *
 * Server defaults to http://localhost:2529; override with CLAUDE_ASSIST_URL.
 * Equivalent curl (the whole API contract):
 *
 *   curl -X POST $CLAUDE_ASSIST_URL/api/capture \
 *     -H 'Content-Type: application/json' \
 *     -d '{"ulid":"<26-char ULID>","text":"...","source":"terminal","captured_at":"<ISO>"}'
 */

import { generateUlid } from '../src/ulid.js';

const server = process.env.CLAUDE_ASSIST_URL ?? 'http://localhost:2529';

const args = process.argv.slice(2);
const tags: string[] = [];
const words: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === '-t' || arg === '--tag') {
    const tag = args[++i];
    if (!tag) {
      console.error('capture: missing value for --tag');
      process.exit(2);
    }
    tags.push(tag);
  } else if (arg === '-h' || arg === '--help') {
    console.log('usage: capture [-t tag]... <text>   (or pipe text on stdin)');
    process.exit(0);
  } else {
    words.push(arg);
  }
}

let text = words.join(' ').trim();
if (!text && !process.stdin.isTTY) {
  text = (await Bun.stdin.text()).trim();
}
if (!text) {
  console.error('capture: nothing to capture (pass text or pipe stdin)');
  process.exit(2);
}

const ulid = generateUlid();

try {
  const response = await fetch(`${server}/api/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ulid,
      text,
      ...(tags.length > 0 ? { tags } : {}),
      source: 'terminal',
      captured_at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`capture: server returned ${response.status}: ${body.slice(0, 300)}`);
    process.exit(1);
  }

  console.log(ulid);
} catch (error) {
  console.error(`capture: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
