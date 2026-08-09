/**
 * The exporter-command source — the documented fallback contract.
 *
 * When a provider has no usable API, or the unofficial one has drifted past
 * repair, the remaining honest option is a browser session that stays logged in
 * on a machine the owner controls, driven headlessly. That browser is *not*
 * this module's business: automating a login flow is provider-specific,
 * fragile, and exactly the kind of thing that should live where the operator
 * can see it fail.
 *
 * So the seam is a **command**, not a browser. The operator supplies an argv
 * array; this module speaks a small JSON protocol to it over stdin/stdout, and
 * knows nothing else. The full contract — request and response envelopes, exit
 * codes, and how to stand up a headless session on a persistent VM — is in the
 * module's RUNBOOK.
 *
 * Protocol, in brief:
 *   stdin   {"op":"preflight"|"transactions"|"accounts"|"categories"|"update",
 *            "startDate":…, "endDate":…, "limit":…, "update":{…}}
 *   stdout  {"ok":true,"data":[…]}                        — success
 *           {"ok":false,"reason":"unauthenticated",
 *            "detail":"session expired"}                  — a clean refusal
 *   exit 0 in both cases. A non-zero exit or unparseable stdout is treated as
 *   `unavailable`: the exporter itself is broken, which is a different problem
 *   from the session being logged out, and the two must stay distinguishable.
 */

import { spawn } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';
import {
  FinanceSourceError,
  type FinanceSource,
  type PreflightResult,
  type SourceAccount,
  type SourceCategory,
  type SourceTransaction,
  type SourceUnavailableReason,
  type TransactionQuery,
  type TransactionUpdate,
} from './types.js';

export interface CommandSourceConfig {
  /** argv array, e.g. ["finance-export", "--profile", "personal"]. */
  command?: string[];
  /** Wall-clock bound on one run (default 3 minutes). */
  timeoutMs?: number;
}

interface ExporterEnvelope {
  ok?: boolean;
  reason?: string;
  detail?: string;
  data?: unknown;
}

const VALID_REASONS: SourceUnavailableReason[] = [
  'not_configured',
  'unauthenticated',
  'unavailable',
  'schema_drift',
];

export class CommandFinanceSource implements FinanceSource {
  readonly mode = 'command' as const;

  constructor(
    private config: CommandSourceConfig,
    private log: FastifyBaseLogger,
  ) {}

  async preflight(): Promise<PreflightResult> {
    if (!this.config.command || this.config.command.length === 0) {
      return {
        ok: false,
        mode: this.mode,
        reason: 'not_configured',
        detail: 'FINANCE_SOURCE_CMD is not set',
      };
    }
    try {
      await this.run({ op: 'preflight' });
      return { ok: true, mode: this.mode };
    } catch (err) {
      const error =
        err instanceof FinanceSourceError
          ? err
          : new FinanceSourceError(String(err), { reason: 'unavailable' });
      return { ok: false, mode: this.mode, reason: error.reason, detail: error.message };
    }
  }

  async listTransactions(query: TransactionQuery): Promise<SourceTransaction[]> {
    const data = await this.run({
      op: 'transactions',
      startDate: query.startDate,
      endDate: query.endDate,
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    return asArray(data, 'transactions').map((row) => normalizeTransaction(row));
  }

  async listAccounts(): Promise<SourceAccount[]> {
    const data = await this.run({ op: 'accounts' });
    return asArray(data, 'accounts').map((row) => ({
      id: String(row.id ?? ''),
      name: String(row.name ?? ''),
      ...(typeof row.type === 'string' ? { type: row.type } : {}),
      ...(typeof row.institution === 'string' ? { institution: row.institution } : {}),
      ...(Number.isFinite(Number(row.balance)) ? { balance: Number(row.balance) } : {}),
      raw: row,
    }));
  }

  async listCategories(): Promise<SourceCategory[]> {
    const data = await this.run({ op: 'categories' });
    return asArray(data, 'categories').map((row) => ({
      id: String(row.id ?? ''),
      name: String(row.name ?? ''),
      ...(typeof row.group === 'string' ? { group: row.group } : {}),
    }));
  }

  async updateTransaction(update: TransactionUpdate): Promise<void> {
    await this.run({ op: 'update', update });
  }

  private async run(request: Record<string, unknown>): Promise<unknown> {
    const argv = this.config.command;
    if (!argv || argv.length === 0) {
      throw new FinanceSourceError('FINANCE_SOURCE_CMD is not set', { reason: 'not_configured' });
    }
    const [bin, ...args] = argv as [string, ...string[]];

    const { code, stdout, stderr } = await execJson(
      bin,
      args,
      JSON.stringify(request),
      this.config.timeoutMs ?? 180_000,
    );

    if (code !== 0 && !stdout.trim()) {
      throw new FinanceSourceError(
        `Finance exporter exited ${code}: ${stderr.slice(0, 300) || 'no stderr'}`,
        { reason: 'unavailable' },
      );
    }

    let envelope: ExporterEnvelope;
    try {
      envelope = JSON.parse(stdout) as ExporterEnvelope;
    } catch {
      throw new FinanceSourceError(
        `Finance exporter did not print a JSON envelope: ${stdout.slice(0, 200)}`,
        { reason: 'unavailable' },
      );
    }

    if (envelope.ok !== true) {
      const reason = VALID_REASONS.includes(envelope.reason as SourceUnavailableReason)
        ? (envelope.reason as SourceUnavailableReason)
        : 'unavailable';
      throw new FinanceSourceError(
        `Finance exporter refused: ${envelope.detail ?? envelope.reason ?? 'no detail'}`,
        { reason },
      );
    }
    if (stderr.trim()) this.log.debug({ stderr: stderr.slice(0, 500) }, 'Finance exporter stderr');
    return envelope.data;
  }
}

/** Exported for tests: the wire shape a raw exporter row is coerced into. */
export function normalizeTransaction(row: Record<string, unknown>): SourceTransaction {
  const amount = Number(row.amount);
  if (!Number.isFinite(amount)) {
    throw new FinanceSourceError('Finance exporter returned a transaction with no numeric amount', {
      reason: 'schema_drift',
    });
  }
  return {
    id: String(row.id ?? ''),
    date: String(row.date ?? ''),
    amount,
    ...(typeof row.currency === 'string' ? { currency: row.currency } : {}),
    ...(typeof row.merchant === 'string' ? { merchant: row.merchant } : {}),
    ...(typeof row.description === 'string' ? { description: row.description } : {}),
    ...(typeof row.accountId === 'string' ? { accountId: row.accountId } : {}),
    ...(typeof row.categoryId === 'string' ? { categoryId: row.categoryId } : {}),
    ...(typeof row.categoryName === 'string' ? { categoryName: row.categoryName } : {}),
    ...(typeof row.notes === 'string' ? { notes: row.notes } : {}),
    tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === 'string') : [],
    pending: Boolean(row.pending),
    needsReview: Boolean(row.needsReview),
    raw: row,
  };
}

function asArray(data: unknown, what: string): Array<Record<string, unknown>> {
  if (!Array.isArray(data)) {
    throw new FinanceSourceError(`Finance exporter returned a non-list for ${what}`, {
      reason: 'schema_drift',
    });
  }
  return data.filter(
    (row): row is Record<string, unknown> =>
      typeof row === 'object' && row !== null && !Array.isArray(row),
  );
}

function execJson(
  bin: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new FinanceSourceError(`Finance exporter timed out after ${timeoutMs}ms`, {
          reason: 'unavailable',
        }),
      );
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new FinanceSourceError(`Finance exporter could not be started: ${err.message}`, {
          reason: 'not_configured',
          cause: err,
        }),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });

    child.stdin.end(stdin);
  });
}
