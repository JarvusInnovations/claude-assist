import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { AxiError } from "axi-sdk-js";

/**
 * Thin HTTP client over the claude-assist REST API (mounted at /api). The
 * server URL is resolved from CLAUDE_ASSIST_SERVER, defaulting to the local
 * dev server. Failures surface as structured AxiErrors rather than raw output.
 */

export const DEFAULT_SERVER = "http://localhost:2529";

type Query = Record<string, string | number | boolean | string[] | undefined | null>;

export function resolveServer(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.CLAUDE_ASSIST_SERVER?.trim();
  return (value || DEFAULT_SERVER).replace(/\/+$/, "");
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
  if (status === 404) return ["Check the ulid — try a `list` command to look one up"];
  if (status === 400) return ["Check required params and value formats for this command"];
  if (status === 409)
    return [
      "Either the resource is terminal (a manual override, or a finished/tossed item) and can't be overwritten, or a recipe push collided with a name it may not replace — read the message: it names the colliding record(s)",
    ];
  if (status === 503) return ["The server is up but this feature is disabled (e.g. no model API key configured)"];
  return [];
}

async function send(
  method: string,
  path: string,
  opts: { query?: Query; body?: unknown; form?: FormData } = {},
): Promise<Response> {
  const server = resolveServer();
  const url = buildUrl(server, path, opts.query);
  const hasJsonBody = opts.body !== undefined && opts.body !== null;
  const init: RequestInit = { method, headers: hasJsonBody ? { "Content-Type": "application/json" } : {} };
  if (opts.form) init.body = opts.form; // fetch sets the multipart boundary itself
  else if (hasJsonBody) init.body = JSON.stringify(opts.body);

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

async function parseBody(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".gif": "image/gif",
};

function mimeForPath(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Build a multipart form: the JSON metadata part (`metaField`) is appended as a
 * **form field** (a string value) — the module's documented part-type rule for
 * the receipt/label meta — and each photo path is appended as a `photos` file
 * part. The meta being a field (not a file) is contractual, so callers and tests
 * can rely on `form.get(metaField)` being a string.
 */
export async function buildMultipartForm(
  metaField: string,
  meta: Record<string, unknown>,
  photoPaths: string[],
): Promise<FormData> {
  const form = new FormData();
  form.append(metaField, JSON.stringify(meta));
  for (const p of photoPaths) {
    const data = await readFile(p);
    form.append("photos", new Blob([data], { type: mimeForPath(p) }), basename(p));
  }
  return form;
}

export const api = {
  async get(path: string, query?: Query): Promise<any> {
    const res = await send("GET", path, { query });
    if (!res.ok) await parseError(res);
    return parseBody(res);
  },
  async post(path: string, body?: unknown, query?: Query): Promise<any> {
    const res = await send("POST", path, { body, query });
    if (!res.ok) await parseError(res);
    return parseBody(res);
  },
  /**
   * POST that keeps the status alongside the body — for endpoints where the code
   * carries meaning the body doesn't (an upsert's 201-created vs 200-replaced,
   * so the caller can say which happened instead of guessing).
   */
  async postWithStatus(path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await send("POST", path, { body });
    if (!res.ok) await parseError(res);
    return { status: res.status, body: await parseBody(res) };
  },
  async postForm(path: string, form: FormData): Promise<any> {
    const res = await send("POST", path, { form });
    if (!res.ok) await parseError(res);
    return parseBody(res);
  },
  async patch(path: string, body: unknown): Promise<any> {
    const res = await send("PATCH", path, { body });
    if (!res.ok) await parseError(res);
    return parseBody(res);
  },
  async del(path: string): Promise<{ ok: boolean; status: number }> {
    const res = await send("DELETE", path);
    if (!res.ok) await parseError(res);
    return { ok: true, status: res.status };
  },
  /** DELETE whose response body matters (e.g. the archived row it returns). */
  async delJson(path: string): Promise<any> {
    const res = await send("DELETE", path);
    if (!res.ok) await parseError(res);
    return parseBody(res);
  },
};
