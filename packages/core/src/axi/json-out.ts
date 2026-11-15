/**
 * `--json-out[=path]`: the full JSON payload written to a file while stdout
 * keeps the TOON view (specs/behaviors/axi-cli-arguments-and-export.md).
 *
 * The flow has three steps, so the path is checked before any work and no
 * command can accept the flag and then ignore it:
 *
 *   1. `requestJsonOut` — called by the flag parser. Validates the path (or
 *      prepares the private temp directory) and throws before anything runs.
 *   2. `captureJson` — called by the command with the payload it fetched.
 *   3. `withJsonOut` — wraps the command. After it returns its view, writes the
 *      file and appends the `wrote:` block. A requested export with nothing
 *      captured is an error, not a silent no-op.
 *
 * Path checks and the write follow agent-recall-axi `src/commands/json-out.ts`
 * (no symlinks, owner-only) and gws-axi `src/util/export.ts` (private temp
 * directory, exclusive create, `export_error:` keeps the view).
 */
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AxiError } from "axi-sdk-js";

export interface JsonOutTarget {
  tool: string;
  /** The command as typed, e.g. `entries list`. Names the auto file. */
  command: string;
  /** The resolved file to write. For a bare flag, a new name in the temp directory. */
  path: string;
  /** True when the path was auto-generated (bare `--json-out`). */
  auto: boolean;
}

interface Pending {
  target: JsonOutTarget;
  captured: boolean;
  payload: unknown;
}

/** The export requested by the invocation in flight. One CLI process runs one command. */
let pending: Pending | undefined;

function refuse(message: string, hint: string): never {
  throw new AxiError(`--json-out: ${message}`, "VALIDATION_ERROR", [hint]);
}

const BARE_HINT = "Pass a bare --json-out for an owner-only file in the temp directory";

function ownedByCaller(st: { uid: number }): boolean {
  return typeof process.getuid !== "function" || st.uid === process.getuid();
}

function expandPath(path: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** The auto-export directory: `<tmpdir>/<tool>`, made private and verified to be ours. */
function privateDir(tool: string): string {
  const dir = join(tmpdir(), tool);
  const explicit = `Pass a path you own instead: --json-out=<path>`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    refuse(`cannot create ${dir} (${(err as NodeJS.ErrnoException).code ?? "error"})`, explicit);
  }
  const st = lstatSync(dir);
  if (!st.isDirectory()) refuse(`${dir} is not a directory (a symlink?)`, explicit);
  if (!ownedByCaller(st)) refuse(`${dir} belongs to another user`, explicit);
  // mkdir's mode is subject to the umask and does nothing to an existing directory.
  chmodSync(dir, 0o700);
  return dir;
}

/** Check an explicit path can be written, without creating anything. */
function validateExplicit(given: string): string {
  const path = expandPath(given);
  const parent = dirname(path);
  let dir;
  try {
    dir = statSync(parent);
  } catch {
    dir = undefined;
  }
  if (!dir?.isDirectory()) {
    refuse(`${path} cannot be written: the directory ${parent} does not exist`, `Create it first, or: ${BARE_HINT}`);
  }
  let st;
  try {
    st = lstatSync(path);
  } catch {
    st = undefined; // a new file
  }
  const hint = `Name a new file or one of your own regular files, or: ${BARE_HINT}`;
  if (st?.isSymbolicLink()) refuse(`${path} is a symlink`, hint);
  if (st?.isDirectory()) refuse(`${path} is a directory`, hint);
  if (st && !st.isFile()) refuse(`${path} is not a regular file`, hint);
  if (st && !ownedByCaller(st)) refuse(`${path} belongs to another user`, hint);
  try {
    accessSync(st ? path : parent, constants.W_OK);
  } catch {
    refuse(`${path} cannot be written: permission denied`, hint);
  }
  return path;
}

/**
 * Register the export for this invocation. `value` is `true` for a bare flag or
 * the text after `=`. Throws `VALIDATION_ERROR` when the file could not be
 * written, so the command fails before it does anything.
 */
export function requestJsonOut(tool: string, command: string, value: true | string, now: Date = new Date()): JsonOutTarget {
  let target: JsonOutTarget;
  if (value === true) {
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const slug = command.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "home";
    target = { tool, command, path: join(privateDir(tool), `${stamp}-${slug}.json`), auto: true };
  } else {
    if (value === "") refuse("--json-out= needs a path after the =", `--json-out=out.json writes there. ${BARE_HINT}`);
    target = { tool, command, path: validateExplicit(value), auto: false };
  }
  pending = { target, captured: false, payload: undefined };
  return target;
}

/** Read and clear the export in flight. */
function takePending(): Pending | undefined {
  const request = pending;
  pending = undefined;
  return request;
}

/** Hand over the payload for the export. A no-op unless `--json-out` was passed. The last call wins. */
export function captureJson(payload: unknown): void {
  if (!pending) return;
  pending.captured = true;
  pending.payload = payload;
}

/** True when this invocation asked for an export. */
export function jsonOutRequested(): boolean {
  return pending !== undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unionKeys(rows: unknown[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) if (isRecord(row)) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

const MAX_NESTED_KEYS = 24;

function nested(keys: string[]): string {
  const shown = keys.slice(0, MAX_NESTED_KEYS);
  const more = keys.length - shown.length;
  return `{${shown.join(",")}${more > 0 ? `,…+${more}` : ""}}`;
}

export interface PayloadShape {
  /** `7 rows, 13 cols` or `1 object, 4 keys`. */
  size: string;
  /** Entries of the `columns:` line; empty when the payload has no keys. */
  columns: string[];
  /** The jq filter that reaches the records. */
  filter: string;
}

/** Describe a payload for the `wrote:` and `columns:` lines and the jq hint. */
export function describePayload(payload: unknown): PayloadShape {
  if (Array.isArray(payload)) {
    const columns = unionKeys(payload);
    return {
      size: columns.length
        ? `${payload.length} row${payload.length === 1 ? "" : "s"}, ${columns.length} col${columns.length === 1 ? "" : "s"}`
        : `${payload.length} item${payload.length === 1 ? "" : "s"}`,
      columns,
      filter: ".[]",
    };
  }
  if (isRecord(payload)) {
    const keys = Object.keys(payload);
    let primary: string | undefined;
    const columns = keys.map((key) => {
      const value = payload[key];
      if (Array.isArray(value)) {
        const rowKeys = unionKeys(value);
        if (primary === undefined && (rowKeys.length > 0 || value.length === 0)) primary = key;
        return `${key}[${value.length}]${rowKeys.length ? nested(rowKeys) : ""}`;
      }
      if (isRecord(value)) return `${key}${nested(Object.keys(value))}`;
      return key;
    });
    const safe = primary !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(primary);
    return {
      size: `1 object, ${keys.length} key${keys.length === 1 ? "" : "s"}`,
      columns,
      filter: primary === undefined ? "." : safe ? `.${primary}[]` : `.[${JSON.stringify(primary)}][]`,
    };
  }
  return { size: payload === null || payload === undefined ? "null" : typeof payload, columns: [], filter: "." };
}

/** POSIX-quote a path for a runnable help line, only when it needs it. */
function quotePath(path: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

type WriteResult = { ok: true; path: string; overwrote: boolean } | { ok: false; path: string; reason: string };

/** Write the file owner-only, never through a symlink. Never throws: the view is already built. */
function writeTarget(target: JsonOutTarget, body: string): WriteResult {
  const dot = target.path.lastIndexOf(".");
  let created: string | undefined;
  try {
    if (target.auto) {
      for (let n = 1; n < 100; n++) {
        const candidate = n === 1 ? target.path : `${target.path.slice(0, dot)}-${n}${target.path.slice(dot)}`;
        let fd: number;
        try {
          fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw err;
        }
        created = candidate;
        try {
          fchmodSync(fd, 0o600);
          writeSync(fd, body);
        } finally {
          closeSync(fd);
        }
        return { ok: true, path: candidate, overwrote: false };
      }
      return { ok: false, path: target.path, reason: "no free file name in the temp directory" };
    }

    let existed = false;
    try {
      existed = lstatSync(target.path).isFile();
    } catch {
      existed = false;
    }
    const fd = openSync(target.path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    if (!existed) created = target.path;
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    return { ok: true, path: target.path, overwrote: existed };
  } catch (err) {
    if (created) rmSync(created, { force: true });
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === "ELOOP"
        ? "the path is a symlink"
        : code === "ENOENT"
          ? "its directory does not exist"
          : code === "EACCES"
            ? "permission denied"
            : (code ?? (err as Error).message);
    return { ok: false, path: created ?? target.path, reason };
  }
}

const HELP_BLOCK = /(^|\n)help\[(\d+)\]:\n((?: {2}.*(?:\n|$))+)$/;

/** Append lines and one hint to a view. The hint joins a trailing `help[]` block when there is one. */
function appendBlock(text: string, lines: string[], hint: string): string {
  const body = text.replace(/\n+$/, "");
  const m = HELP_BLOCK.exec(body);
  if (!m) return [body, ...lines, "help[1]:", `  ${hint}`].filter((l) => l !== "").join("\n");
  const head = body.slice(0, m.index);
  const helpLines = m[3]!.replace(/\n$/, "");
  return [head, ...lines, `help[${Number(m[2]) + 1}]:`, helpLines, `  ${hint}`].filter((l) => l !== "").join("\n");
}

/**
 * Wrap a command handler so a requested export is written after its view is
 * built. Without `--json-out` the handler's output passes through untouched.
 */
export function withJsonOut<A extends unknown[]>(handler: (...args: A) => Promise<string>): (...args: A) => Promise<string> {
  return async (...args: A) => {
    takePending();
    let text: string;
    let request: Pending | undefined;
    try {
      text = await handler(...args);
    } finally {
      request = takePending();
    }
    if (!request) return text;
    const { target } = request;
    if (!request.captured) {
      throw new AxiError(`--json-out: \`${target.command}\` produced no JSON payload`, "INTERNAL_ERROR", [
        "Nothing was written. Run the command without --json-out",
      ]);
    }

    const result = writeTarget(target, `${JSON.stringify(request.payload ?? null, null, 2)}\n`);
    if (!result.ok) {
      process.exitCode = 1;
      return appendBlock(
        text,
        [`export_error: could not write ${result.path}: ${result.reason}`],
        target.auto
          ? "Nothing was written; pass a path you can write: --json-out=<path>"
          : "Nothing was written; fix the path, or pass a bare --json-out for a file in the temp directory",
      );
    }
    const shape = describePayload(request.payload ?? null);
    return appendBlock(
      text,
      [
        `${result.overwrote ? "overwrote" : "wrote"}: ${result.path} (${shape.size})`,
        shape.columns.length ? `columns: ${shape.columns.join(", ")}` : "",
      ],
      `Run \`jq '${shape.filter}' ${quotePath(result.path)}\` to process the full result`,
    );
  };
}
