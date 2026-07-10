import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXAMPLE_SEED_CONTENT,
  loadSeedFile,
  resolveSeedContent,
  validateSeedContent,
} from './seed-rules.js';

function tmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'seed-rules-'));
  const path = join(dir, name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('resolveSeedContent', () => {
  it('returns the built-in examples when no seed file is set', () => {
    expect(resolveSeedContent()).toBe(EXAMPLE_SEED_CONTENT);
    expect(resolveSeedContent('')).toBe(EXAMPLE_SEED_CONTENT);
  });

  it('example content is generic and clearly labelled', () => {
    // Every example rule id/name is explicitly marked as an example so nobody
    // mistakes the built-ins for a real, tuned ruleset.
    for (const r of EXAMPLE_SEED_CONTENT.rules) {
      expect(r.rule_id).toContain('example');
      expect(r.name.toLowerCase()).toContain('example');
    }
    // Any from_patterns only reference public/provider domains, never a
    // specific organization's mail domain.
    const patterns = EXAMPLE_SEED_CONTENT.rules.flatMap((r) => r.from_patterns ?? []);
    for (const p of patterns) {
      expect(p === 'calendar.google.com' || p.includes('*')).toBe(true);
    }
  });

  it('loads and validates a seed file when the path is set', () => {
    const path = tmpFile(
      'seed.json',
      JSON.stringify({
        rules: [{ rule_id: 'r1', name: 'Rule One', action: 'archive' }],
        topics: [{ topic_type: 'keyword', value: 'widgets' }],
      })
    );
    const content = resolveSeedContent(path);
    expect(content.rules).toHaveLength(1);
    expect(content.rules[0]?.rule_id).toBe('r1');
    expect(content.topics[0]?.value).toBe('widgets');
  });
});

describe('loadSeedFile', () => {
  it('throws a descriptive error when the file is missing', () => {
    expect(() => loadSeedFile('/no/such/seed-file.json')).toThrow(/Could not read/);
  });

  it('throws when the file is not valid JSON', () => {
    const path = tmpFile('bad.json', '{ not json');
    expect(() => loadSeedFile(path)).toThrow(/not valid JSON/);
  });

  it('tolerates missing rules/topics arrays (treats as empty)', () => {
    const path = tmpFile('empty.json', JSON.stringify({}));
    const content = loadSeedFile(path);
    expect(content.rules).toEqual([]);
    expect(content.topics).toEqual([]);
  });
});

describe('validateSeedContent', () => {
  it('rejects non-object input', () => {
    expect(() => validateSeedContent(42, 'x')).toThrow(/must be a JSON object/);
  });

  it('rejects a non-array rules field', () => {
    expect(() => validateSeedContent({ rules: 'nope' }, 'x')).toThrow(/"rules" must be an array/);
  });

  it('requires rule_id, name, and action on each rule', () => {
    expect(() => validateSeedContent({ rules: [{ name: 'x', action: 'archive' }] }, 'x')).toThrow(
      /rules\[0\]\.rule_id is required/
    );
    expect(() => validateSeedContent({ rules: [{ rule_id: 'r', action: 'archive' }] }, 'x')).toThrow(
      /rules\[0\]\.name is required/
    );
    expect(() => validateSeedContent({ rules: [{ rule_id: 'r', name: 'x' }] }, 'x')).toThrow(
      /rules\[0\]\.action is required/
    );
  });

  it('requires topic_type and value on each topic', () => {
    expect(() => validateSeedContent({ topics: [{ value: 'v' }] }, 'x')).toThrow(
      /topics\[0\]\.topic_type is required/
    );
    expect(() => validateSeedContent({ topics: [{ topic_type: 'keyword' }] }, 'x')).toThrow(
      /topics\[0\]\.value is required/
    );
  });
});
