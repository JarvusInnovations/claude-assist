/**
 * The provider's own HTTP API, spoken directly.
 *
 * The API this targets is **unofficial and undocumented**: a GraphQL endpoint
 * behind a token login, which the provider is free to change without notice.
 * Three deliberate consequences shape this file:
 *
 * 1. **The GraphQL documents live in one place** (`documents.ts`) and are sent
 *    as full query text rather than persisted-query hashes, so a drift is a
 *    one-file edit and not a reverse-engineering session.
 * 2. **Field extraction is defensive.** Responses are read through narrow
 *    accessors that tolerate a renamed wrapper and fail with `schema_drift`
 *    rather than silently yielding zero transactions. A pull that returns
 *    nothing because the shape moved must not look like a quiet month.
 * 3. **`preflight()` is a real probe**, not a config check. It is what lets the
 *    monthly batch exit clean the day the API changes, instead of rendering a
 *    confidently empty review.
 *
 * Nothing here is instance data: the base URL, the account, and the credentials
 * all arrive as config, with no defaults.
 */

import type { FastifyBaseLogger } from 'fastify';
import {
  FinanceSourceError,
  type FinanceSource,
  type PreflightResult,
  type SourceAccount,
  type SourceCategory,
  type SourceTransaction,
  type TransactionQuery,
  type TransactionUpdate,
} from './types.js';
import {
  ACCOUNTS_QUERY,
  CATEGORIES_QUERY,
  ME_QUERY,
  TRANSACTIONS_QUERY,
  UPDATE_TRANSACTION_MUTATION,
} from './documents.js';
import { totpCode } from './totp.js';

/** Persisted session token, so a pull doesn't re-trip MFA on every run. */
export interface SessionStore {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ApiSourceConfig {
  /** e.g. https://api.<provider>.com — no default; see the module RUNBOOK. */
  baseUrl?: string;
  email?: string;
  password?: string;
  totpSecret?: string;
  /** A token the operator minted by hand; present ⇒ no credentials are sent. */
  token?: string;
  timeoutMs?: number;
}

interface GraphQlError {
  message?: string;
  extensions?: Record<string, unknown>;
}

interface GraphQlBody<T> {
  data?: T;
  errors?: GraphQlError[];
}

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_TRANSACTION_LIMIT = 2000;
const PAGE_SIZE = 250;

export class ApiFinanceSource implements FinanceSource {
  readonly mode = 'api' as const;

  private token: string | null = null;
  private loginPromise: Promise<string> | null = null;

  constructor(
    private config: ApiSourceConfig,
    private sessions: SessionStore,
    private log: FastifyBaseLogger,
  ) {}

  /** Everything the API mode needs before it can even try. */
  private missingConfig(): string | null {
    if (!this.config.baseUrl) return 'FINANCE_API_BASE_URL';
    if (this.config.token) return null;
    if (!this.config.email) return 'FINANCE_API_EMAIL';
    if (!this.config.password) return 'FINANCE_API_PASSWORD';
    return null;
  }

  async preflight(): Promise<PreflightResult> {
    const missing = this.missingConfig();
    if (missing) {
      return {
        ok: false,
        mode: this.mode,
        reason: 'not_configured',
        detail: `${missing} is not set`,
      };
    }
    try {
      // A probe, not a ping: it authenticates AND round-trips one real
      // document, which is the only thing that catches a moved schema.
      const data = await this.graphql<Record<string, unknown>>(ME_QUERY, {});
      const ok = data !== null && typeof data === 'object' && 'me' in data;
      if (!ok) {
        return {
          ok: false,
          mode: this.mode,
          reason: 'schema_drift',
          detail: 'identity probe returned an unexpected shape',
        };
      }
      return { ok: true, mode: this.mode };
    } catch (err) {
      const error = asSourceError(err);
      return {
        ok: false,
        mode: this.mode,
        reason: error.reason,
        detail: error.message,
      };
    }
  }

  async listTransactions(query: TransactionQuery): Promise<SourceTransaction[]> {
    const cap = query.limit ?? DEFAULT_TRANSACTION_LIMIT;
    const out: SourceTransaction[] = [];
    let offset = 0;

    while (out.length < cap) {
      const limit = Math.min(PAGE_SIZE, cap - out.length);
      const data = await this.graphql<Record<string, unknown>>(TRANSACTIONS_QUERY, {
        limit,
        offset,
        orderBy: 'date',
        filters: { startDate: query.startDate, endDate: query.endDate },
      });
      const page = readList(data, ['allTransactions', 'results'], 'transactions');
      for (const row of page) out.push(mapTransaction(row));
      if (page.length < limit) break;
      offset += page.length;
    }
    return out;
  }

  async listAccounts(): Promise<SourceAccount[]> {
    const data = await this.graphql<Record<string, unknown>>(ACCOUNTS_QUERY, {});
    return readList(data, ['accounts'], 'accounts').map(mapAccount);
  }

  async listCategories(): Promise<SourceCategory[]> {
    const data = await this.graphql<Record<string, unknown>>(CATEGORIES_QUERY, {});
    return readList(data, ['categories'], 'categories').map((row) => ({
      id: String(row.id ?? ''),
      name: String(row.name ?? ''),
      ...(readObject(row.group)?.name ? { group: String(readObject(row.group)!.name) } : {}),
    }));
  }

  async updateTransaction(update: TransactionUpdate): Promise<void> {
    const input: Record<string, unknown> = { id: update.id };
    if (update.categoryId !== undefined) input.category = update.categoryId;
    if (update.notes !== undefined) input.notes = update.notes;

    const data = await this.graphql<Record<string, unknown>>(UPDATE_TRANSACTION_MUTATION, {
      input,
    });
    const payload = readObject(readObject(data)?.updateTransaction);
    const errors = payload?.errors;
    if (errors !== undefined && errors !== null) {
      throw new FinanceSourceError(`Provider rejected the transaction update: ${JSON.stringify(errors)}`, {
        reason: 'unavailable',
      });
    }
  }

  // ── transport ───────────────────────────────────────────────────────────

  private async graphql<T>(document: string, variables: Record<string, unknown>): Promise<T> {
    const attempt = async (token: string): Promise<Response> =>
      fetch(`${this.baseUrl()}/graphql`, {
        method: 'POST',
        signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        headers: {
          Authorization: `Token ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Client-Platform': 'web',
        },
        body: JSON.stringify({ query: document, variables }),
      });

    let response = await attempt(await this.ensureToken());
    if (response.status === 401 || response.status === 403) {
      // The stored token expired or was revoked. Drop it and log in once more;
      // a second rejection is an operator problem, not a transport one.
      await this.sessions.clear();
      this.token = null;
      this.loginPromise = null;
      response = await attempt(await this.ensureToken());
    }

    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new FinanceSourceError(`Provider rejected our credentials (HTTP ${response.status})`, {
          reason: 'unauthenticated',
        });
      }
      throw new FinanceSourceError(
        `Provider API HTTP ${response.status}: ${text.slice(0, 300)}`,
        { reason: 'unavailable' },
      );
    }

    let body: GraphQlBody<T>;
    try {
      body = JSON.parse(text) as GraphQlBody<T>;
    } catch (err) {
      throw new FinanceSourceError('Provider API returned a non-JSON body', {
        reason: 'schema_drift',
        cause: err,
      });
    }

    if (body.errors?.length) {
      const message = body.errors.map((e) => e.message ?? 'unknown').join('; ');
      // A GraphQL validation error means our document no longer matches the
      // schema — precisely the drift the fallback exists for.
      throw new FinanceSourceError(`Provider GraphQL error: ${message.slice(0, 300)}`, {
        reason: /unknown (field|argument|type)|cannot query field/i.test(message)
          ? 'schema_drift'
          : 'unavailable',
      });
    }
    if (body.data === undefined) {
      throw new FinanceSourceError('Provider GraphQL response had no data', {
        reason: 'schema_drift',
      });
    }
    return body.data;
  }

  private baseUrl(): string {
    const base = this.config.baseUrl;
    if (!base) {
      throw new FinanceSourceError('FINANCE_API_BASE_URL is not set', { reason: 'not_configured' });
    }
    return base.replace(/\/+$/, '');
  }

  private async ensureToken(): Promise<string> {
    if (this.config.token) return this.config.token;
    if (this.token) return this.token;

    const stored = await this.sessions.read();
    if (stored) {
      this.token = stored;
      return stored;
    }
    // Collapse concurrent callers onto one login: a second simultaneous MFA
    // attempt is how an account gets rate-limited or locked.
    this.loginPromise ??= this.login().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  private async login(): Promise<string> {
    const { email, password, totpSecret } = this.config;
    if (!email || !password) {
      throw new FinanceSourceError('No stored session and no credentials to log in with', {
        reason: 'not_configured',
      });
    }

    const payload: Record<string, unknown> = {
      username: email,
      password,
      trusted_device: true,
      supports_mfa: true,
      supports_email_otp: false,
    };
    if (totpSecret) payload.totp = await totpCode(totpSecret);

    const response = await fetch(`${this.baseUrl()}/auth/login/`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Client-Platform': 'web',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    if (!response.ok) {
      const mfa = /mfa|otp|two.?factor/i.test(text);
      throw new FinanceSourceError(
        mfa && !totpSecret
          ? 'Provider login requires MFA and FINANCE_API_TOTP_SECRET is not set'
          : `Provider login failed (HTTP ${response.status})`,
        { reason: 'unauthenticated' },
      );
    }

    let parsed: { token?: unknown };
    try {
      parsed = JSON.parse(text) as { token?: unknown };
    } catch (err) {
      throw new FinanceSourceError('Provider login returned a non-JSON body', {
        reason: 'schema_drift',
        cause: err,
      });
    }
    if (typeof parsed.token !== 'string' || !parsed.token) {
      throw new FinanceSourceError('Provider login returned no token', { reason: 'schema_drift' });
    }

    this.token = parsed.token;
    await this.sessions.write(parsed.token);
    this.log.info('Finance: obtained a new provider session token');
    return parsed.token;
  }
}

// ── response reading ──────────────────────────────────────────────────────

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Walk a dotted path to an array, failing as `schema_drift` when the shape
 * doesn't hold. The alternative — returning `[]` — is how a moved schema turns
 * into a review that says "no spending this month".
 */
function readList(
  data: unknown,
  path: string[],
  what: string,
): Array<Record<string, unknown>> {
  let cursor: unknown = data;
  for (const key of path) {
    const obj = readObject(cursor);
    if (!obj || !(key in obj)) {
      throw new FinanceSourceError(
        `Provider response is missing ${path.join('.')} — the ${what} query no longer matches the API`,
        { reason: 'schema_drift' },
      );
    }
    cursor = obj[key];
  }
  if (!Array.isArray(cursor)) {
    throw new FinanceSourceError(
      `Provider response for ${what} was not a list at ${path.join('.')}`,
      { reason: 'schema_drift' },
    );
  }
  return cursor.filter((row): row is Record<string, unknown> => readObject(row) !== null);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function mapTransaction(row: Record<string, unknown>): SourceTransaction {
  const category = readObject(row.category);
  const merchant = readObject(row.merchant);
  const account = readObject(row.account);
  const amount = Number(row.amount);
  if (!Number.isFinite(amount)) {
    throw new FinanceSourceError('Provider returned a transaction with no numeric amount', {
      reason: 'schema_drift',
    });
  }
  const tags = Array.isArray(row.tags)
    ? row.tags
        .map((tag) => (readObject(tag)?.name ?? tag))
        .filter((tag): tag is string => typeof tag === 'string')
    : [];

  return {
    id: String(row.id ?? ''),
    date: String(row.date ?? ''),
    amount,
    ...(optionalString(row.currency) ? { currency: optionalString(row.currency)! } : {}),
    ...(merchant?.name ? { merchant: String(merchant.name) } : {}),
    ...(optionalString(row.plaidName) ? { description: optionalString(row.plaidName)! } : {}),
    ...(account?.id ? { accountId: String(account.id) } : {}),
    ...(category?.id ? { categoryId: String(category.id) } : {}),
    ...(category?.name ? { categoryName: String(category.name) } : {}),
    ...(optionalString(row.notes) ? { notes: optionalString(row.notes)! } : {}),
    tags,
    pending: Boolean(row.pending),
    needsReview: Boolean(row.needsReview ?? row.needs_review),
    raw: row,
  };
}

export function mapAccount(row: Record<string, unknown>): SourceAccount {
  const type = readObject(row.type);
  const subtype = readObject(row.subtype);
  const institution = readObject(row.institution);
  const balance = Number(row.currentBalance ?? row.displayBalance);
  return {
    id: String(row.id ?? ''),
    name: String(row.displayName ?? row.name ?? ''),
    ...(type?.name ? { type: String(type.name) } : {}),
    ...(subtype?.name ? { subtype: String(subtype.name) } : {}),
    ...(institution?.name ? { institution: String(institution.name) } : {}),
    ...(Number.isFinite(balance) ? { balance } : {}),
    ...(row.isAsset !== undefined ? { isAsset: Boolean(row.isAsset) } : {}),
    raw: row,
  };
}

function asSourceError(err: unknown): FinanceSourceError {
  if (err instanceof FinanceSourceError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new FinanceSourceError(message, { reason: 'unavailable' });
}
