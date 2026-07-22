import { describe, expect, it } from 'bun:test';
import { SYSTEM_PROMPT_TEXT } from './receipt-parser.js';

describe('receipt parser prompt (§ Prices)', () => {
  it('instructs verbatim price transcription and the total self-check that re-reads, never reconciles', () => {
    expect(SYSTEM_PROMPT_TEXT).toContain('price_cents');
    expect(SYSTEM_PROMPT_TEXT).toContain('total_cents');
    expect(SYSTEM_PROMPT_TEXT).toContain('PRINTED EXTENDED price');
    expect(SYSTEM_PROMPT_TEXT).toContain('RE-EXAMINE');
    expect(SYSTEM_PROMPT_TEXT).toContain('NEVER adjust any number');
    // The multibuy quantity-marker rule survives unchanged.
    expect(SYSTEM_PROMPT_TEXT).toContain('DO NOT emit the bare "N @ price" marker');
  });
});
