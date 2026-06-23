import { AxiError } from "axi-sdk-js";

/**
 * Thin HTTP client over the claude-assist REST API (mounted at /api). The
 * server URL is resolved from CLAUDE_ASSIST_SERVER, defaulting to the local
 * dev server. Failures surface as structured AxiErrors rather than raw output.
 */

export const DEFAULT_SERVER = "http://localhost:2529";

type Query = Record<string, string | number | boolean | string[] | undefined | null>;

export function resolveServer(): string {
  const env = process.env.CLAUDE_ASSIST_SERVER?.trim();
  return (env || DEFAULT_SERVER).replace(/\/+$/, "");
}

function buildUrl(server: string, path: string, query?: Query): string {
  let url = `${server}${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) {
        for (const item of v) if (item !== undefined && item !== null && item !== "") qs.append(k, String(item));
      } else {
        qs.append(k, String(v));
      }
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  return url;
}

function suggestForStatus(status: number): string[] {
  if (status === 404) return ["Check the id — try `search` to look one up"];
  if (status === 400) return ["Check required params and value formats for this command"];
  if (status === 503) return ["The server is up but this feature may be disabled (e.g. ANTHROPIC_API_KEY not set)"];
  return [];
}

async function send(
  method: string,
  path: string,
  opts: { query?: Query; body?: unknown } = {},
): Promise<Response> {
  const server = resolveServer();
  const url = buildUrl(server, path, opts.query);
  const hasBody = opts.body !== undefined && opts.body !== null;
  const init: RequestInit = { method, headers: hasBody ? { "Content-Type": "application/json" } : {} };
  if (hasBody) init.body = JSON.stringify(opts.body);

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new AxiError(
      `Cannot reach claude-assist server at ${server} (${(err as Error).message})`,
      "HTTP_ERROR",
      ["Set CLAUDE_ASSIST_SERVER or start the server (cd apps/server && docker-compose up -d)"],
    );
  }
  return res;
}

async function parseError(res: Response): Promise<never> {
  const text = await res.text();
  let message = res.statusText || `HTTP ${res.status}`;
  if (text) {
    try {
      const data = JSON.parse(text);
      if (data && typeof data === "object" && data.error) message = data.error;
      else if (data && typeof data === "object" && data.message) message = data.message;
    } catch {
      message = text.slice(0, 200);
    }
  }
  throw new AxiError(`API error (${res.status}): ${message}`, "HTTP_ERROR", suggestForStatus(res.status));
}

export const api = {
  async get(path: string, query?: Query): Promise<any> {
    const res = await send("GET", path, { query });
    if (!res.ok) await parseError(res);
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  },
  /** GET an endpoint that returns text/plain (e.g. transcripts). */
  async getText(path: string, query?: Query): Promise<string> {
    const res = await send("GET", path, { query });
    if (!res.ok) await parseError(res);
    return res.text();
  },
  async post(path: string, body?: unknown, query?: Query): Promise<any> {
    return mutate("POST", path, body, query);
  },
  async patch(path: string, body?: unknown): Promise<any> {
    return mutate("PATCH", path, body);
  },
  async del(path: string): Promise<any> {
    return mutate("DELETE", path);
  },
};

async function mutate(method: string, path: string, body?: unknown, query?: Query): Promise<any> {
  const res = await send(method, path, { body, query });
  if (!res.ok) await parseError(res);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
