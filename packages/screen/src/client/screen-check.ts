/**
 * screen-check — the client an external tool configures as its screen command.
 * See `specs/modules/screen.md` § Client.
 *
 * Reads the request JSON on stdin, posts it to the screen endpoint, prints the
 * verdict JSON on stdout and exits 0 for either verdict. Any failure prints
 * NOTHING on stdout, one line on stderr, and exits non-zero, so a caller can
 * never mistake a failure for a verdict.
 *
 * Runs under plain Node once bundled: no Bun globals, no workspace imports.
 */

export const DEFAULT_SERVER = 'http://localhost:2529';
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface CheckResult {
  /** Present only for a valid verdict. */
  stdout?: string;
  stderr?: string;
  exitCode: number;
}

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function resolveServer(env: Env): string {
  const value = env.CLAUDE_ASSIST_SERVER?.trim();
  return (value || DEFAULT_SERVER).replace(/\/+$/, '');
}

function resolveTimeout(env: Env): number {
  const raw = env.CLAUDE_ASSIST_SCREEN_TIMEOUT_MS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** The verdict contract, checked again on this side: a 2xx is not enough. */
export function isVerdict(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort().join(',');
  if (obj.verdict === 'pass') return keys === 'verdict';
  if (obj.verdict === 'block') {
    return (
      keys === 'passage,reason,verdict' &&
      typeof obj.passage === 'string' &&
      obj.passage.trim() !== '' &&
      typeof obj.reason === 'string' &&
      obj.reason.trim() !== ''
    );
  }
  return false;
}

const fail = (message: string, exitCode = 1): CheckResult => ({ stderr: `screen-check: ${message}`, exitCode });

export async function screenCheck(input: string, env: Env, fetchImpl: FetchLike = fetch): Promise<CheckResult> {
  const token = env.CLAUDE_ASSIST_SCREEN_TOKEN?.trim();
  if (!token) return fail('CLAUDE_ASSIST_SCREEN_TOKEN is not set', 2);

  let request: unknown;
  try {
    request = JSON.parse(input);
  } catch {
    return fail('stdin is not valid JSON', 2);
  }

  const url = `${resolveServer(env)}/api/screen`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolveTimeout(env));
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (err) {
    const aborted = controller.signal.aborted;
    return fail(aborted ? 'request timed out' : `request failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status !== 200) {
    let code = '';
    try {
      const body = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
      if (typeof body.error?.code === 'string') code = ` ${body.error.code}`;
      if (typeof body.error?.message === 'string') code += `: ${body.error.message}`;
    } catch {
      // Not our envelope; the status alone is the message.
    }
    return fail(`HTTP ${response.status}${code}`);
  }

  let verdict: unknown;
  try {
    verdict = JSON.parse(text);
  } catch {
    return fail('response is not JSON');
  }
  if (!isVerdict(verdict)) return fail('response is not a valid verdict');
  return { stdout: JSON.stringify(verdict), exitCode: 0 };
}
