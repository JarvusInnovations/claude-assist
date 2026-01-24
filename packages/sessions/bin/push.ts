#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { push } from '../src/cli.js';

const { values } = parseArgs({
  options: {
    machine: { type: 'string', short: 'm' },
    server: { type: 'string', short: 's', default: 'http://localhost:3000' },
    'claude-dir': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
});

if (values.help || !values.machine) {
  console.log(`
claude-assist-sessions - Push Claude Code sessions to a remote server

Usage:
  bunx @jarvus/claude-assist-sessions push --machine <id> [options]

Options:
  -m, --machine <id>     Machine identifier (required, e.g., "laptop", "devbox")
  -s, --server <url>     Server URL (default: http://localhost:3000)
  --claude-dir <path>    Claude directory (default: ~/.claude)
  --dry-run              Scan but don't push
  -v, --verbose          Verbose output
  -h, --help             Show this help

Examples:
  bunx @jarvus/claude-assist-sessions push --machine laptop
  bunx @jarvus/claude-assist-sessions push -m devbox -s https://my-server.com
  bunx @jarvus/claude-assist-sessions push -m laptop --dry-run -v
`);
  process.exit(values.help ? 0 : 1);
}

push({
  machineId: values.machine,
  serverUrl: values.server!,
  claudeDir: values['claude-dir'],
  dryRun: values['dry-run'],
  verbose: values.verbose,
}).catch((error) => {
  console.error('Push failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
