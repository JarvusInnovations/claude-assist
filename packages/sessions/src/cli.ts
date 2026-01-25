import { hostname as getHostname } from 'node:os';
import { SessionScanner } from './scanner.js';
import type {
  PushPayload,
  SessionPushData,
  SyncResult,
  InventoryPayload,
  InventoryResponse,
} from './types.js';

export interface PushOptions {
  machineId: string;
  serverUrl: string;
  claudeDir?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

/**
 * Push local sessions to a remote server using two-phase sync
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

  const scanner = new SessionScanner({ claudeDir });

  // Phase 1: Get inventory and check with server
  log(`Scanning for sessions...`);
  if (claudeDir) {
    log(`Using Claude directory: ${claudeDir}`);
  }

  const inventory = await scanner.getSessionInventory();

  console.log(`Found ${inventory.length} sessions locally`);

  if (inventory.length === 0) {
    console.log('No sessions found to push');
    return;
  }

  if (dryRun) {
    console.log('Dry run - would check inventory with server');
    for (const item of inventory) {
      log(`  ${item.sessionId} (hash: ${item.transcriptHash.slice(0, 8)}...)`);
    }
    return;
  }

  // Send inventory to server
  const inventoryPayload: InventoryPayload = {
    machineId,
    hostname: getHostname(),
    inventory,
  };

  log(`Checking inventory with ${serverUrl}/sessions/inventory...`);

  const inventoryResponse = await fetch(`${serverUrl}/sessions/inventory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(inventoryPayload),
  });

  if (!inventoryResponse.ok) {
    const text = await inventoryResponse.text();
    throw new Error(
      `Inventory check failed: ${inventoryResponse.status} ${inventoryResponse.statusText}\n${text}`
    );
  }

  const inventoryResult = (await inventoryResponse.json()) as InventoryResponse;

  console.log(
    `Server needs ${inventoryResult.neededSessionIds.length} sessions (${inventoryResult.upToDateCount} already up-to-date)`
  );

  // Phase 2: Send only needed sessions
  if (inventoryResult.neededSessionIds.length === 0) {
    console.log('All sessions already synced - nothing to push');
    return;
  }

  log(`Loading ${inventoryResult.neededSessionIds.length} sessions to push...`);
  const neededIds = new Set(inventoryResult.neededSessionIds);
  const sessionsToSend = await scanner.getSessionsByIds(neededIds);

  const sessions: SessionPushData[] = sessionsToSend.map((session) => {
    log(
      `  ${session.sessionId} (${Math.round(session.transcriptContent.length / 1024)}KB)`
    );
    return {
      signal: session.signal,
      sessionId: session.sessionId,
      transcriptPath: session.transcriptPath,
      transcript: session.transcriptContent,
    };
  });

  const payload: PushPayload = {
    machineId,
    hostname: getHostname(),
    sessions,
  };

  const totalSize = JSON.stringify(payload).length;
  console.log(
    `Pushing ${sessions.length} sessions (${Math.round(totalSize / 1024)}KB) to ${serverUrl}/sessions/push...`
  );

  const response = await fetch(`${serverUrl}/sessions/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Push failed: ${response.status} ${response.statusText}\n${text}`
    );
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
