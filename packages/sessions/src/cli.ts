import { hostname as getHostname } from 'node:os';
import { SessionScanner } from './scanner.js';
import type { PushPayload, SessionPushData, SyncResult } from './types.js';

export interface PushOptions {
  machineId: string;
  serverUrl: string;
  claudeDir?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

/**
 * Push local sessions to a remote server
 */
export async function push(options: PushOptions): Promise<void> {
  const {
    machineId,
    serverUrl,
    claudeDir,
    dryRun = false,
    verbose = false,
  } = options;

  const log = verbose ? console.log.bind(console) : () => {};

  log(`Scanning for sessions...`);
  if (claudeDir) {
    log(`Using Claude directory: ${claudeDir}`);
  }

  const scanner = new SessionScanner({ claudeDir });
  const discovered = await scanner.getAllSessions();

  log(`Found ${discovered.length} sessions`);

  if (discovered.length === 0) {
    console.log('No sessions found to push');
    return;
  }

  // Build push payload
  const sessions: SessionPushData[] = discovered.map((session) => {
    log(`  ${session.sessionId} (${Math.round(session.transcriptContent.length / 1024)}KB)`);
    return {
      signal: session.signal,
      sessionId: session.sessionId,
      transcriptPath: session.transcriptPath,
      transcript: session.transcriptContent,
    };
  });

  console.log(`Collected ${sessions.length} sessions to push`);

  if (dryRun) {
    console.log('Dry run - not pushing to server');
    return;
  }

  const payload: PushPayload = {
    machineId,
    hostname: getHostname(),
    sessions,
  };

  console.log(`Pushing to ${serverUrl}/sessions/push...`);

  const response = await fetch(`${serverUrl}/sessions/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Push failed: ${response.status} ${response.statusText}\n${text}`);
  }

  const result = (await response.json()) as SyncResult;

  console.log('Push complete:');
  console.log(`  Ingested: ${result.sessionsIngested}`);
  console.log(`  Updated: ${result.sessionsUpdated}`);
  console.log(`  Skipped: ${result.sessionsSkipped}`);

  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
    for (const error of result.errors) {
      console.error(`    - ${error}`);
    }
  }
}
