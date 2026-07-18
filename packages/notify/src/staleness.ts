/**
 * Staleness + host-health evaluation for the daily monitor.
 *
 * The pure functions (evaluateStaleness, parseWatermarkDate, evaluateDiskHealth)
 * carry the load-bearing logic and are unit-tested. `runStalenessCheck` wires
 * them to Postgres, the ledger files, and the dispatcher.
 */

import { readFile } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type postgres from 'postgres';
import type { NotifyDispatcher } from '@jarvus/claude-assist-core';

export type StalenessLevel = 'ok' | 'notice' | 'interrupt';

export interface StalenessInput {
  /** Effective coverage timestamp (ms epoch): last success or ledger watermark. */
  effectiveMs: number;
  nowMs: number;
  thresholdMs: number;
}

export interface StalenessResult {
  ageMs: number;
  ratio: number;
  level: StalenessLevel;
}

/**
 * A pipeline is stale once its age exceeds the threshold; it escalates from
 * `notice` to `interrupt` past 2× the threshold (a failing system earns the
 * push channel per interrupts-are-earned).
 */
export function evaluateStaleness(input: StalenessInput): StalenessResult {
  const ageMs = input.nowMs - input.effectiveMs;
  const ratio = input.thresholdMs > 0 ? ageMs / input.thresholdMs : Infinity;
  let level: StalenessLevel = 'ok';
  if (ratio > 2) level = 'interrupt';
  else if (ratio > 1) level = 'notice';
  return { ageMs, ratio, level };
}

/**
 * Hand-parse a leading frontmatter block into flat `key: value` scalars. No
 * YAML/TOML dependency — ledgers only ever need simple scalars, and two
 * dialects are in play depending on how the ledger was authored:
 *   - gitsheets content-typed markdown: TOML fenced in `+++`, e.g.
 *     `analyzed_through = 2026-06-29`.
 *   - Plain YAML fenced in `---`, e.g. `analyzed_through: 2026-06-29`.
 * Both accept a bare date or a quoted string containing one. Returns null if
 * the text doesn't open with a recognized fence line, or the block is never
 * closed (malformed), so callers can fall back cleanly.
 */
function parseFrontmatter(text: string): Record<string, string> | null {
  const lines = text.split('\n');
  const fence = lines[0]?.trim();
  if (fence !== '---' && fence !== '+++') return null;

  const frontmatter: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === fence) return frontmatter;

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*[:=]\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1] ?? '';
    let value = (kv[2] ?? '').trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }

  // Never found a closing fence — malformed, treat as absent.
  return null;
}

/**
 * Extract the coverage watermark date from a coverage-ledger file.
 *
 * New-style ledgers carry it as frontmatter, either gitsheets TOML (`+++`)
 * or plain YAML (`---`):
 *   +++
 *   analyzed_through = 2026-06-29
 *   partial = "AM only, resumed after outage"
 *   +++
 * or:
 *   ---
 *   analyzed_through: 2026-06-29
 *   partial: "AM only, resumed after outage"
 *   ---
 * Older ledgers state it on a line containing "through" instead:
 *   "**Thoroughly analyzed through: 2026-06-29 end-of-day ET.**"
 *   "**Complete through:** 2026-06-29 (full day; closed out 6:15pm EDT)"
 * Returns the date at end-of-day UTC, or null if none is found.
 */
export function parseWatermarkDate(text: string): Date | null {
  const dateRe = /(\d{4})-(\d{2})-(\d{2})/;

  const frontmatter = parseFrontmatter(text);
  const analyzedThrough = frontmatter?.analyzed_through;
  if (analyzedThrough) {
    const m = analyzedThrough.match(dateRe);
    if (m) {
      const parsed = new Date(`${m[1]}-${m[2]}-${m[3]}T23:59:59Z`);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    // analyzed_through present but unparseable — fall through to legacy scan.
  }

  const lines = text.split('\n');

  const fromThroughLine = lines
    .filter((l) => /through/i.test(l))
    .map((l) => l.match(dateRe))
    .find((m) => m !== null);

  const match = fromThroughLine ?? text.match(dateRe);
  if (!match) return null;

  // End-of-day UTC: generous against day-scale thresholds, avoids false alarms.
  const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T23:59:59Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface DiskHealthInput {
  freeBytes: number;
  totalBytes: number;
  minFreeBytes: number;
  /** 0–1. */
  minFreePct: number;
}

export interface DiskHealthResult {
  alert: boolean;
  freeBytes: number;
  freePct: number;
  level: 'interrupt';
  reason?: string;
}

/**
 * Alert when free space drops below an absolute floor OR a percentage floor.
 * (a host's root filesystem hit 100% / 12 MB free unnoticed — this is that backstop.)
 */
export function evaluateDiskHealth(input: DiskHealthInput): DiskHealthResult {
  const freePct = input.totalBytes > 0 ? input.freeBytes / input.totalBytes : 0;
  const belowBytes = input.freeBytes < input.minFreeBytes;
  const belowPct = freePct < input.minFreePct;
  const alert = belowBytes || belowPct;
  const reasons: string[] = [];
  if (belowBytes) reasons.push(`free ${gib(input.freeBytes)} < ${gib(input.minFreeBytes)} floor`);
  if (belowPct) reasons.push(`free ${(freePct * 100).toFixed(1)}% < ${(input.minFreePct * 100).toFixed(0)}% floor`);
  return {
    alert,
    freeBytes: input.freeBytes,
    freePct,
    level: 'interrupt',
    reason: reasons.join('; ') || undefined,
  };
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GiB`;
}

function fmtAge(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

interface HeartbeatCheckRow {
  name: string;
  last_success_at: Date | null;
  created_at: Date;
  threshold_seconds: string;
  source: 'heartbeat' | 'manual';
  ledger_path: string | null;
}

export interface StalenessCheckDeps {
  sql: postgres.Sql;
  notify: NotifyDispatcher;
  log: FastifyBaseLogger;
  agentRepoPath?: string;
  diskCheckPath: string;
  diskMinFreeBytes: number;
  diskMinFreePct: number;
}

export interface StalenessCheckSummary {
  checked: number;
  stale: number;
  alerts: number;
  diskAlert: boolean;
}

/**
 * The daily check: every registered pipeline, plus host disk health. Dispatches
 * a `notice` (escalating to `interrupt` past 2× threshold) for each stale
 * pipeline, and an `interrupt` when disk free space is below the floor.
 */
export async function runStalenessCheck(
  deps: StalenessCheckDeps
): Promise<StalenessCheckSummary> {
  const { sql, notify, log } = deps;
  const now = Date.now();

  const rows = await sql<HeartbeatCheckRow[]>`
    SELECT name, last_success_at, created_at,
           EXTRACT(EPOCH FROM threshold_interval)::text AS threshold_seconds,
           source, ledger_path
    FROM notify.pipeline_heartbeats
    ORDER BY name
  `;

  let stale = 0;
  let alerts = 0;

  for (const row of rows) {
    const thresholdMs = Number(row.threshold_seconds) * 1000;
    let effectiveMs: number | null = null;
    let detail = '';

    if (row.source === 'manual') {
      const rel = row.ledger_path;
      if (!rel) {
        log.warn({ pipeline: row.name }, 'Manual heartbeat has no ledger_path');
        continue;
      }
      const abs = deps.agentRepoPath ? join(deps.agentRepoPath, rel) : rel;
      try {
        const text = await readFile(abs, 'utf-8');
        const watermark = parseWatermarkDate(text);
        if (!watermark) {
          alerts++;
          await notify.notify({
            priority: 'notice',
            title: `Coverage ledger unreadable: ${row.name}`,
            body: `Could not parse a watermark date from ${rel}.`,
          });
          continue;
        }
        effectiveMs = watermark.getTime();
        detail = `watermark ${watermark.toISOString().slice(0, 10)}`;
      } catch (err) {
        alerts++;
        await notify.notify({
          priority: 'notice',
          title: `Coverage ledger missing: ${row.name}`,
          body: `Could not read ${rel}: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
    } else {
      // Never-beaten pipelines fall back to created_at so a pipeline that never
      // succeeds still eventually pages.
      effectiveMs = (row.last_success_at ?? row.created_at).getTime();
      detail = row.last_success_at
        ? `last success ${row.last_success_at.toISOString()}`
        : 'never succeeded';
    }

    const result = evaluateStaleness({ effectiveMs, nowMs: now, thresholdMs });
    if (result.level === 'ok') continue;

    stale++;
    alerts++;
    await notify.notify({
      priority: result.level === 'interrupt' ? 'interrupt' : 'notice',
      title: `Pipeline stale: ${row.name}`,
      body:
        `${row.name} is ${fmtAge(result.ageMs)} behind ` +
        `(threshold ${fmtAge(thresholdMs)}, ${result.ratio.toFixed(1)}×). ${detail}.`,
    });
  }

  // Host disk health.
  let diskAlert = false;
  try {
    const st = statfsSync(deps.diskCheckPath);
    const freeBytes = st.bavail * st.bsize;
    const totalBytes = st.blocks * st.bsize;
    const disk = evaluateDiskHealth({
      freeBytes,
      totalBytes,
      minFreeBytes: deps.diskMinFreeBytes,
      minFreePct: deps.diskMinFreePct,
    });
    if (disk.alert) {
      diskAlert = true;
      alerts++;
      await notify.notify({
        priority: 'interrupt',
        title: `Low disk on ${deps.diskCheckPath}`,
        body: `Disk health: ${disk.reason}. Free ${gib(freeBytes)} of ${gib(totalBytes)}.`,
      });
    }
  } catch (err) {
    log.error({ err, path: deps.diskCheckPath }, 'Disk health check failed');
  }

  log.info({ checked: rows.length, stale, alerts, diskAlert }, 'Staleness check complete');
  return { checked: rows.length, stale, alerts, diskAlert };
}
