/**
 * Minimal parser for the TOON-ish table format the `-axi` CLIs emit:
 *
 *   count: 3 open
 *   commitments[3]{slug,title,due_date}:
 *     finalize-jgs7,"Finalize and send…",2026-04-07
 *     ...
 *   help[1]:
 *     Run `--help` …
 *
 * A section header is `name[N]{col,col,…}:`; the next N indented lines are CSV
 * rows with `"`-quoting. We key off the header (not the count line) and stop at
 * the first flush-left line so a trailing `help[…]` block never leaks in.
 */

export interface ToonTable {
  name: string;
  columns: string[];
  rows: string[][];
}

/** CSV field splitter handling `"`-quoting and `""` escapes. */
export function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    let field = '';
    if (line[i] === '"') {
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else {
          field += line[i++];
        }
      }
    } else {
      while (i < line.length && line[i] !== ',') field += line[i++];
    }
    out.push(field);
    if (line[i] === ',') {
      i++;
      continue;
    }
    break;
  }
  return out;
}

/**
 * Parse the first table section matching `name`. Returns null when absent.
 */
export function parseToonTable(output: string, name: string): ToonTable | null {
  const lines = output.split('\n');
  const headerRe = new RegExp(`^${name}\\[(\\d+)\\]\\{([^}]*)\\}:`);
  const headerIdx = lines.findIndex((l) => headerRe.test(l.trim()));
  if (headerIdx === -1) return null;

  const match = lines[headerIdx]!.trim().match(headerRe);
  if (!match) return null;
  const count = Number(match[1]);
  const columns = match[2]!.split(',').map((c) => c.trim());

  const rows: string[][] = [];
  for (let i = headerIdx + 1; i < lines.length && rows.length < count; i++) {
    const raw = lines[i]!;
    if (!/^\s/.test(raw)) break;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    rows.push(parseCsvRow(trimmed));
  }
  return { name, columns, rows };
}

/** Map a row to a record keyed by column name, with '' for missing/short rows. */
export function rowRecord(columns: string[], values: string[]): Record<string, string> {
  const rec: Record<string, string> = {};
  columns.forEach((col, idx) => {
    rec[col] = values[idx] ?? '';
  });
  return rec;
}
