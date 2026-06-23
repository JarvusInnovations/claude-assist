import { encode } from "@toon-format/toon";

/**
 * Field extractors that flatten an API row into a small, TOON-friendly object.
 * Most of the token savings over raw JSON come from dropping fields agents
 * rarely need and collapsing nested structures into single named columns.
 */
export type FieldDef =
  | { type: "field"; key: string; as?: string }
  | { type: "pluck"; key: string; subkey: string; as?: string }
  | { type: "joinArray"; key: string; subkey?: string; as?: string; empty?: string }
  | { type: "count"; key: string; as?: string }
  | { type: "relativeTime"; key: string; as?: string }
  | { type: "dateOnly"; key: string; as?: string }
  | { type: "boolYesNo"; key: string; as?: string }
  | { type: "truncate"; key: string; limit?: number; as?: string }
  | { type: "custom"; as: string; fn: (item: Record<string, any>) => unknown };

export function field(key: string, as?: string): FieldDef {
  return { type: "field", key, as };
}
export function pluck(key: string, subkey: string, as?: string): FieldDef {
  return { type: "pluck", key, subkey, as: as ?? key };
}
export function joinArray(key: string, subkey?: string, as?: string, empty = "none"): FieldDef {
  return { type: "joinArray", key, subkey, as, empty };
}
export function count(key: string, as?: string): FieldDef {
  return { type: "count", key, as };
}
export function relativeTime(key: string, as?: string): FieldDef {
  return { type: "relativeTime", key, as };
}
export function dateOnly(key: string, as?: string): FieldDef {
  return { type: "dateOnly", key, as };
}
export function truncate(key: string, limit?: number, as?: string): FieldDef {
  return { type: "truncate", key, limit, as };
}
export function custom(as: string, fn: (item: Record<string, any>) => unknown): FieldDef {
  return { type: "custom", as, fn };
}

function outputKey(def: FieldDef): string {
  if (def.type === "custom") return def.as;
  return def.as ?? def.key;
}

export function extract(item: Record<string, any>, schema: FieldDef[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const def of schema) {
    const key = outputKey(def);
    switch (def.type) {
      case "field":
        result[key] = item[def.key] ?? null;
        break;
      case "pluck":
        result[key] = (item[def.key] as Record<string, unknown> | undefined)?.[def.subkey] ?? null;
        break;
      case "joinArray": {
        const arr = item[def.key];
        if (Array.isArray(arr) && arr.length > 0) {
          result[key] = arr
            .map((x: unknown) =>
              def.subkey && x && typeof x === "object" ? (x as Record<string, unknown>)[def.subkey] : x,
            )
            .join(",");
        } else {
          result[key] = def.empty ?? "none";
        }
        break;
      }
      case "count": {
        const arr = item[def.key];
        result[key] = Array.isArray(arr) ? arr.length : 0;
        break;
      }
      case "relativeTime":
        result[key] = formatRelativeTime(item[def.key]);
        break;
      case "dateOnly":
        result[key] = formatDateOnly(item[def.key]);
        break;
      case "boolYesNo":
        result[key] = item[def.key] ? "yes" : "no";
        break;
      case "truncate":
        result[key] = truncateText(item[def.key], def.limit).value;
        break;
      case "custom":
        result[key] = def.fn(item);
        break;
    }
  }
  return result;
}

/** Render a labeled collection as a TOON table. */
export function renderList(label: string, items: Record<string, any>[], schema: FieldDef[]): string {
  return encode({ [label]: items.map((item) => extract(item, schema)) });
}

/** Render a single labeled object as TOON. */
export function renderDetail(label: string, item: Record<string, any>, schema: FieldDef[]): string {
  return encode({ [label]: extract(item, schema) });
}

/** Render an arbitrary already-shaped object as TOON. */
export function renderObject(obj: Record<string, unknown>): string {
  return encode(obj);
}

/**
 * Render next-step suggestions. Done by hand rather than via encode() because
 * encode inlines primitive arrays onto one line; agents read these more
 * reliably as an indented block.
 */
export function renderHelp(lines: string[]): string {
  const clean = lines.filter(Boolean);
  if (clean.length === 0) return "";
  return `help[${clean.length}]:\n${clean.map((l) => `  ${l}`).join("\n")}`;
}

/** Join TOON blocks into a single stdout payload, dropping empties. */
export function renderOutput(blocks: string[]): string {
  return blocks.filter(Boolean).join("\n");
}

const DEFAULT_TRUNCATE = 280;

/** Truncate a long text field, reporting whether (and by how much) it was cut. */
export function truncateText(
  text: unknown,
  limit = DEFAULT_TRUNCATE,
): { value: string | null; truncated: boolean; total: number } {
  if (typeof text !== "string") return { value: (text as null) ?? null, truncated: false, total: 0 };
  if (text.length <= limit) return { value: text, truncated: false, total: text.length };
  return {
    value: `${text.slice(0, limit)}… (truncated, ${text.length} chars total)`,
    truncated: true,
    total: text.length,
  };
}

function formatDateOnly(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(value as string);
  if (isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

/** Human relative time for a timestamp (e.g. "3d ago"). */
export function formatRelativeTime(value: unknown): string {
  if (!value) return "unknown";
  const then = new Date(value as string).getTime();
  if (isNaN(then)) return "unknown";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  const past = diffSec >= 0;
  const s = Math.abs(diffSec);
  const fmt = (n: number, unit: string) => (past ? `${n}${unit} ago` : `in ${n}${unit}`);
  if (s < 60) return past ? "just now" : "soon";
  const min = Math.floor(s / 60);
  if (min < 60) return fmt(min, "m");
  const hr = Math.floor(min / 60);
  if (hr < 24) return fmt(hr, "h");
  const day = Math.floor(hr / 24);
  if (day < 30) return fmt(day, "d");
  const mon = Math.floor(day / 30);
  if (mon < 12) return fmt(mon, "mo");
  return fmt(Math.floor(mon / 12), "y");
}
