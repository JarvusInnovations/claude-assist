import { hostname as getHostname } from 'node:os';
import { SessionScanner } from './scanner.js';
import { DEFAULT_INGEST_BUDGET_BYTES } from './chunked-ingest.js';
import type {
  PushPayload,
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
  /** Force re-parsing of all sessions even if hash matches (for parser upgrades) */
  force?: boolean;
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
    force = false,
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

  if (force) {
    console.log('Force mode: all sessions will be re-parsed regardless of hash');
  }

  if (inventory.length === 0) {
    console.log('No sessions found to push');
    return;
  }

  // Send inventory to server (even in dry-run to verify connectivity)
  const inventoryPayload: InventoryPayload = {
    machineId,
    hostname: getHostname(),
    inventory,
    forceReparse: force,
  };

  log(`Checking inventory with ${serverUrl}/api/sessions/inventory...`);

  const inventoryResponse = await fetch(`${serverUrl}/api/sessions/inventory`, {
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

  // Dry run: stop after inventory check (server connectivity verified)
  if (dryRun) {
    console.log('Dry run - skipping push phase');
    if (inventoryResult.neededSessionIds.length > 0) {
      log('Sessions that would be pushed:');
      for (const sessionId of inventoryResult.neededSessionIds) {
        log(`  ${sessionId}`);
      }
    }
    return;
  }

  // Phase 2: Send only needed sessions
  if (inventoryResult.neededSessionIds.length === 0) {
    console.log('All sessions already synced - nothing to push');
    return;
  }

  log(`Loading ${inventoryResult.neededSessionIds.length} sessions to push...`);
  const neededIds = new Set(inventoryResult.neededSessionIds);
  // Per-session baseline from the inventory response tells us how much of
  // each file the server already has, so we send only the tail
  // (specs/behaviors/session-transcript-storage.md: "Satellite push"). A
  // session missing from `baselines` (new to the server) sends from byte
  // zero, itself capped at the ingest budget — the rest follows over
  // subsequent push cycles as the server's `ingested_bytes` advances.
  const sessions = await scanner.getSessionsByIds(
    neededIds,
    inventoryResult.baselines,
    DEFAULT_INGEST_BUDGET_BYTES
  );
  for (const session of sessions) {
    log(`  ${session.sessionId} (${Math.round(session.transcript.length / 1024)}KB from byte ${session.sinceBytes ?? 0})`);
  }

  const payload: PushPayload = {
    machineId,
    hostname: getHostname(),
    sessions,
    forceReparse: force,
  };

  const totalSize = JSON.stringify(payload).length;
  console.log(
    `Pushing ${sessions.length} sessions (${Math.round(totalSize / 1024)}KB) to ${serverUrl}/api/sessions/push...`
  );

  const response = await fetch(`${serverUrl}/api/sessions/push`, {
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
