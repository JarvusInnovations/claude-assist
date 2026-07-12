import { describe, expect, it } from 'bun:test';
import {
  evaluateStaleness,
  evaluateDiskHealth,
  parseWatermarkDate,
} from './staleness.js';

const HOUR = 3_600_000;

describe('evaluateStaleness', () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0);

  it('is ok within the threshold', () => {
    const r = evaluateStaleness({ effectiveMs: now - 6 * HOUR, nowMs: now, thresholdMs: 12 * HOUR });
    expect(r.level).toBe('ok');
  });

  it('is a notice past the threshold', () => {
    const r = evaluateStaleness({ effectiveMs: now - 18 * HOUR, nowMs: now, thresholdMs: 12 * HOUR });
    expect(r.level).toBe('notice');
    expect(r.ratio).toBeGreaterThan(1);
  });

  it('escalates to interrupt past 2× the threshold', () => {
    const r = evaluateStaleness({ effectiveMs: now - 30 * HOUR, nowMs: now, thresholdMs: 12 * HOUR });
    expect(r.level).toBe('interrupt');
    expect(r.ratio).toBeGreaterThan(2);
  });

  it('treats the exact threshold boundary as still ok', () => {
    const r = evaluateStaleness({ effectiveMs: now - 12 * HOUR, nowMs: now, thresholdMs: 12 * HOUR });
    expect(r.level).toBe('ok');
  });
});

describe('parseWatermarkDate', () => {
  it('parses the HQ coverage watermark line', () => {
    const text = [
      '# HQ Analysis Coverage Ledger',
      '## Watermark',
      '**Thoroughly analyzed through: 2026-06-29 end-of-day ET.**',
    ].join('\n');
    const d = parseWatermarkDate(text);
    expect(d?.toISOString().slice(0, 10)).toBe('2026-06-29');
  });

  it('parses the Harvest coverage watermark line', () => {
    const text = '**Complete through:** 2026-06-29 (full day; closed out 6:15pm EDT)';
    const d = parseWatermarkDate(text);
    expect(d?.toISOString().slice(0, 10)).toBe('2026-06-29');
  });

  it('prefers a "through" line over an unrelated earlier date', () => {
    const text = [
      'Created 2020-01-01 as a placeholder.',
      'Complete through: 2026-07-05',
    ].join('\n');
    const d = parseWatermarkDate(text);
    expect(d?.toISOString().slice(0, 10)).toBe('2026-07-05');
  });

  it('returns null when no date is present', () => {
    expect(parseWatermarkDate('no dates here')).toBeNull();
  });

  it('prefers the analyzed_through frontmatter key when present (YAML --- fence)', () => {
    const text = [
      '---',
      'analyzed_through: 2026-06-29',
      '---',
      '# HQ Analysis Coverage Ledger',
      'Complete through: 2020-01-01 (stale placeholder body text)',
    ].join('\n');
    const d = parseWatermarkDate(text);
    expect(d?.toISOString().slice(0, 10)).toBe('2026-06-29');
  });

  it('prefers the analyzed_through frontmatter key when present (TOML +++ fence)', () => {
    const text = [
      '+++',
      'analyzed_through = 2026-06-29',
      '+++',
      '# HQ Analysis Coverage Ledger',
      'Complete through: 2020-01-01 (stale placeholder body text)',
    ].join('\n');
    const d = parseWatermarkDate(text);
    expect(d?.toISOString().slice(0, 10)).toBe('2026-06-29');
  });

  it('falls back to the "through"-line scan when frontmatter is absent', () => {
    const text = [
      '# HQ Analysis Coverage Ledger',
      '**Complete through:** 2026-07-05',
    ].join('\n');
    const d = parseWatermarkDate(text);
    expect(d?.toISOString().slice(0, 10)).toBe('2026-07-05');
  });

  it('accepts a quoted analyzed_through value (YAML --- fence)', () => {
    const text = ['---', 'analyzed_through: "2026-06-29"', '---', 'body'].join('\n');
    const d = parseWatermarkDate(text);
    expect(d?.toISOString().slice(0, 10)).toBe('2026-06-29');
  });

  it('accepts a quoted analyzed_through value with trailing annotation (TOML +++ fence)', () => {
    const text = [
      '+++',
      'analyzed_through = "2026-06-29 end-of-day ET"',
      '+++',
      'body',
    ].join('\n');
    const d = parseWatermarkDate(text);
    expect(d?.toISOString().slice(0, 10)).toBe('2026-06-29');
  });

  it('reads the optional partial companion key without affecting the watermark', () => {
    const text = [
      '+++',
      'analyzed_through = 2026-06-29',
      'partial = "AM only, resumed after outage"',
      '+++',
      'body',
    ].join('\n');
    const d = parseWatermarkDate(text);
    expect(d?.toISOString().slice(0, 10)).toBe('2026-06-29');
  });

  it('falls through to the legacy scan when YAML frontmatter is malformed (unclosed)', () => {
    const text = [
      '---',
      'status: draft',
      '# no closing delimiter, body follows',
      'Complete through: 2026-07-05',
    ].join('\n');
    const d = parseWatermarkDate(text);
    expect(d?.toISOString().slice(0, 10)).toBe('2026-07-05');
  });

  it('falls through to the legacy scan when TOML frontmatter is malformed (unclosed)', () => {
    const text = [
      '+++',
      'status = "draft"',
      '# no closing delimiter, body follows',
      'Complete through: 2026-07-05',
    ].join('\n');
    const d = parseWatermarkDate(text);
    expect(d?.toISOString().slice(0, 10)).toBe('2026-07-05');
  });
});

describe('evaluateDiskHealth', () => {
  const GIB = 1024 ** 3;

  it('does not alert with ample free space', () => {
    const r = evaluateDiskHealth({
      freeBytes: 100 * GIB,
      totalBytes: 500 * GIB,
      minFreeBytes: 20 * GIB,
      minFreePct: 0.08,
    });
    expect(r.alert).toBe(false);
  });

  it('alerts on the absolute byte floor (the devbox 12MB-free case)', () => {
    const r = evaluateDiskHealth({
      freeBytes: 12 * 1024 * 1024, // 12 MiB
      totalBytes: 500 * GIB,
      minFreeBytes: 20 * GIB,
      minFreePct: 0.08,
    });
    expect(r.alert).toBe(true);
    expect(r.level).toBe('interrupt');
  });

  it('alerts on the percentage floor even when bytes look large', () => {
    const r = evaluateDiskHealth({
      freeBytes: 30 * GIB,
      totalBytes: 1000 * GIB, // 3% free
      minFreeBytes: 20 * GIB,
      minFreePct: 0.08,
    });
    expect(r.alert).toBe(true);
    expect(r.reason).toContain('%');
  });
});
