/**
 * Entry point for the bundled `screen-check` command. See `screen-check.ts`.
 */

import { screenCheck } from './screen-check.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  let input: string;
  try {
    input = await readStdin();
  } catch {
    process.stderr.write('screen-check: could not read stdin\n');
    return 2;
  }
  const result = await screenCheck(input, process.env);
  if (result.stdout !== undefined) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr !== undefined) process.stderr.write(`${result.stderr}\n`);
  return result.exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stderr.write('screen-check: unexpected failure\n');
    process.exitCode = 1;
  },
);
